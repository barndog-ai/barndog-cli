import type { RuntimeContext } from "../../runtime.js";
import { basename } from "node:path";
import {
  readSettings,
  SetupRequiredError,
  type Settings,
} from "../../config/settings.js";
import { selectionState } from "../../config/environment.js";
import { readState } from "../../config/state.js";
import { treeFingerprint } from "../workspace/tree.js";
import { linkTarget } from "../environment/transaction.js";
import { environmentCatalog } from "../server/catalog.js";
import { openRepoSource } from "../workspace/workspace-source.js";
import {
  localOverlay,
  mergeLocalCatalog,
  moveDestination,
  readMoved,
  withOverlay,
} from "../workspace/overlay.js";
import { cloudSource } from "../workspace/cloud-source.js";
import type { RepoSource } from "../workspace/repo-source.js";
import type { AssetReference } from "../asset-selection/types.js";
import { secretRefs } from "../../harnesses/formats.js";
import { missingValues, type Secrets } from "../secrets/index.js";
import { keptValues } from "../environment/kept-values.js";
import { resolveAssets } from "../asset-selection/index.js";
import { installedName, resolveClashes } from "../environment/names.js";
import { originLabel, scopes } from "../server/origin.js";
import type { Harness } from "../../harnesses/types.js";
import type { AssetKind } from "../../config/selection.js";
import { isAssetKind } from "../asset-kinds/index.js";
import { isHarness } from "../../harnesses/registry.js";
import { hookBlocked } from "./hook-readiness.js";

export type InventoryState =
  | "installed"
  | "disabled"
  | "pending"
  /** Selected, but this machine lacks what its implementations need, so no tool runs it. */
  | "cant-run"
  /** Selected, but it has no implementation for any selected tool. */
  | "no-version"
  | "outdated"
  | "clash"
  | "modified"
  | "removing";

export type InventoryItem = {
  id: string;
  kind: AssetKind;
  name: string;
  installedName: string;
  origin: string;
  via: string[];
  state: InventoryState;
  harnesses: Harness[];
  paths: string[];
  /**
   * MCP servers only, when `inventory()` was asked to check them: the local
   * variables the server refers to that have no value on this machine.
   */
  unsetVariables?: string[];
  /** MCP servers only, when checked: every variable the server refers to. */
  variables?: string[];
};

export type InventoryOptions = {
  /** Read each selected MCP server's definition to find variables with no value here. */
  checkVariables?: boolean;
};

/**
 * Installation overview. Offline can indicate either a cached Git snapshot or a
 * fallback to saved installation state.
 */
export type Inventory = {
  harnesses: Harness[];
  server: string | null;
  knowledge: boolean;
  /** Set when the workspace could not be reached; items then come from local state only. */
  offline: string | null;
  items: InventoryItem[];
  /** Local assets moving to the shared workspace, waiting for their shared copy. */
  moving: { kind: string; name: string; to: string }[];
};

/** Local assets still moving to the shared workspace; none without a local folder. */
async function pendingMoves(settings: Settings) {
  const folder = settings.localWorkspace?.path;
  const records = folder ? await readMoved(folder) : [];

  return records.map((entry) => ({
    kind: entry.kind,
    name: entry.name,
    to: moveDestination(entry),
  }));
}

/** What is selected and what is actually installed on this machine. */
/** The state of a selected asset; the first that applies wins. */
function inventoryState(asset: {
  enabled: boolean;
  clashed: boolean;
  modified: boolean;
  /** Linked or registered in at least one harness. */
  present: boolean;
  /** The installed version is older than the published one. */
  outdated: boolean;
  /** Why sync installs it nowhere, when it is a Hook no selected tool can run. */
  blocked: "cant-run" | "no-version" | null;
}): InventoryState {
  if (!asset.enabled) {
    return "disabled";
  }

  if (asset.clashed) {
    return "clash";
  }

  if (asset.modified) {
    return "modified";
  }

  if (!asset.present) {
    return asset.blocked ?? "pending";
  }

  return asset.outdated ? "outdated" : "installed";
}

/** The state of an installed asset no longer selected. */
function leftoverState(modified: boolean, offline: boolean): InventoryState {
  if (modified) {
    return "modified";
  }

  return offline ? "installed" : "removing";
}

/**
 * Finds an MCP server's variables with no value here, reading its definition
 * from the same sources the inventory's catalog came from.
 */
function variableCheck(input: {
  /** False when the caller didn't ask; every item then has no field. */
  wanted: boolean;
  settings: Settings;
  repo: RepoSource | undefined;
  overlay: RepoSource | undefined;
  runtime: RuntimeContext;
}): (entry: {
  asset: AssetReference;
  enabled: boolean;
}) => Promise<Pick<InventoryItem, "unsetVariables" | "variables">> {
  const { settings, repo, overlay, runtime } = input;
  const conn = settings.connection;
  const primary = repo ?? (conn ? cloudSource(conn, runtime) : undefined);
  const source = primary && overlay ? withOverlay(primary, overlay) : primary;
  let kept: Promise<Secrets> | undefined;

  return async ({ asset, enabled }) => {
    if (!input.wanted || !source || asset.kind !== "mcp") {
      return {};
    }

    // Read once, and only when some server needs checking.
    kept ??= keptValues(runtime);
    const values = (await kept).servers[asset.id] ?? {};
    const definition = await source.mcpDefinition(asset);
    const variables = [
      ...new Set(
        Object.values(secretRefs(definition)).map((ref) => ref.secretRef),
      ),
    ];

    return {
      variables,
      ...(enabled
        ? {
            unsetVariables: missingValues(definition, values, runtime.env).map(
              (missing) => missing.variable,
            ),
          }
        : {}),
    };
  };
}

/**
 * Compares configured selections, catalog and installed files to report status;
 * unreachable sources fall back to local state.
 */
export async function inventory(
  runtime: RuntimeContext,
  options: InventoryOptions = {},
): Promise<Inventory> {
  const { home } = runtime;

  const settings = await readSettings(home);
  if (!settings) {
    throw new SetupRequiredError();
  }

  const state = await readState(home);
  const { native, installed } = state;
  const conn = settings.connection;
  const localNames = settings.localNames ?? {};
  const linksOf = (id: string) => state.links.filter((l) => l.id === id);
  const nativeOf = (id: string) => native.filter((n) => n.id === id);
  const items: InventoryItem[] = [];
  const seen = new Set<string>();
  // The same comparisons that stop sync, so status can't call these up to date.
  const modified = new Set<string>();
  for (const tree of installed) {
    const actual = await treeFingerprint(tree.path, runtime);
    if (tree.fingerprint && actual !== null && actual !== tree.fingerprint) {
      modified.add(tree.id);
    }
  }

  for (const link of state.links) {
    const actual = await linkTarget(link.target);
    if (actual !== null && actual !== link.source) {
      modified.add(link.id);
    }
  }

  let offline: string | null = null;
  const repo = openRepoSource(settings, runtime, { refresh: "auto" });
  if (conn || repo) {
    try {
      const { catalog: primaryCatalog, scopes: loadScopes } =
        await (async () => {
          if (repo) {
            const model = await repo.model();
            offline = repo.notices()[0] ?? null;

            return {
              catalog: model.catalog,
              scopes: () => Promise.resolve(model.scopes),
            };
          }

          const remote = await environmentCatalog(runtime, conn);

          return {
            catalog: remote.catalog,
            scopes: () => scopes(remote.connection, runtime),
          };
        })();

      const overlay = localOverlay(settings, runtime);
      const catalog = overlay
        ? await mergeLocalCatalog(primaryCatalog, overlay)
        : primaryCatalog;

      const variablesOf = variableCheck({
        wanted: Boolean(options.checkVariables),
        settings,
        repo,
        overlay,
        runtime,
      });

      const selection = selectionState(settings);
      const effective = resolveAssets(catalog, selection);
      const outcome = await resolveClashes(
        effective.assets.flatMap(({ asset, enabled }) => {
          const { kind } = asset;
          if (!enabled || kind === "hook") {
            return [];
          }

          return [
            {
              id: asset.id,
              kind,
              name: asset.name,
              origin: asset.origin,
              installed:
                linksOf(asset.id).length > 0 || nativeOf(asset.id).length > 0,
            },
          ];
        }),
        localNames,
      );

      const clashed = new Set(outcome.skipped.map((c) => c.incoming.id));
      for (const entry of effective.assets) {
        const { asset } = entry;
        seen.add(asset.id);
        const links = linksOf(asset.id);
        const entries = nativeOf(asset.id);
        const tree = installed.find((t) => t.id === asset.id);
        const present = links.length > 0 || entries.length > 0;
        const blocked = await hookBlocked(
          {
            kind: asset.kind,
            enabled: entry.enabled,
            present,
            installed: tree,
          },
          settings.harnesses,
          runtime,
        );

        const harnesses = [
          ...new Set([
            ...links.map((l) => l.harness),
            ...entries.map((n) => n.harness).filter(isHarness),
          ]),
        ];

        items.push({
          id: asset.id,
          kind: asset.kind,
          name: asset.name,
          installedName: installedName(asset, outcome.localNames),
          origin: originLabel(asset.origin),
          via: entry.contributions.map((c) =>
            c.type === "individual"
              ? "individual"
              : originLabel(asset.origin.localOnly ? asset.origin : c.scope),
          ),
          state: inventoryState({
            enabled: entry.enabled,
            clashed: clashed.has(asset.id),
            modified: modified.has(asset.id),
            present,
            outdated: Boolean(
              tree?.versionId && tree.versionId !== asset.publishedVersion,
            ),
            blocked,
          }),
          harnesses,
          paths: [
            ...(tree ? [tree.path] : []),
            ...links.map((l) => l.target),
            ...new Set(entries.map((n) => `${n.file} (${n.key})`)),
          ],
          ...(await variablesOf(entry)),
        });
      }

      const visible = await loadScopes();
      for (const item of items) {
        item.via = item.via.map((label) => {
          const [type, id] = label.split("/");
          const scope = visible.find(
            (s) => s.type === type && (type === "org" || s.id === id),
          );

          return scope ? originLabel(scope) : label;
        });
      }
    } catch (error) {
      offline = error instanceof Error ? error.message : String(error);
    }
  }

  // Anything BarnDog installed that is no longer selected, or everything when offline.
  for (const id of new Set([
    ...state.links.map((l) => l.id),
    ...native
      .filter((n) => n.kind !== "knowledge" && n.kind !== "sync")
      .map((n) => n.id),
  ])) {
    if (seen.has(id)) {
      continue;
    }

    const links = linksOf(id);
    const entries = nativeOf(id);
    const [link] = links;
    const [entry] = entries;
    const kind = link ? "skill" : entry?.kind;
    if (!isAssetKind(kind)) {
      continue;
    }

    const installedPath = installed.find((t) => t.id === id)?.path;
    const installedFolder = installedPath ? basename(installedPath) : undefined;

    const unlinkedName = kind === "mcp" ? entry?.key : installedFolder;
    const name = link ? basename(link.target) : (unlinkedName ?? id);

    items.push({
      id,
      kind,
      name,
      installedName: name,
      origin: "—",
      via: [],
      state: leftoverState(modified.has(id), Boolean(offline)),
      harnesses: [
        ...new Set([
          ...links.map((l) => l.harness),
          ...entries.map((n) => n.harness).filter(isHarness),
        ]),
      ],
      paths: [
        ...links.map((l) => l.target),
        ...new Set(entries.map((n) => `${n.file} (${n.key})`)),
      ],
    });
  }

  items.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.installedName.localeCompare(b.installedName),
  );

  return {
    harnesses: settings.harnesses,
    server: conn?.server ?? repo?.label ?? null,
    knowledge: !!(conn || repo) && settings.knowledge !== false,
    offline,
    items,
    moving: await pendingMoves(settings),
  };
}
