import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { readSettings, SetupRequiredError } from "../../config/settings.js";
import { selectionState } from "../../config/environment.js";
import { readState } from "../../config/state.js";
import { treeFingerprint } from "../environment/installed.js";
import { fileText, linkTarget } from "../environment/transaction.js";
import { environmentCatalog, request } from "../environment/remote.js";
import { openRepoSource } from "../environment/workspace-source.js";
import { localOverlay, mergeLocalCatalog } from "../git-workspace/overlay.js";
import { scopeSchema } from "@barndog-ai/api-contract";
import { resolveAssets } from "../asset-selection/index.js";
import {
  installedName,
  originLabel,
  resolveClashes,
} from "../environment/names.js";
import { asRecord } from "../../shared/values.js";
import type { Harness } from "../../harnesses/types.js";
import type { AssetKind } from "../asset-selection/types.js";
import { isAssetKind } from "../asset-kinds/index.js";
import { isHarness } from "../../harnesses/registry.js";

export type InventoryState =
  | "installed"
  | "disabled"
  | "pending"
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
};

export type Inventory = {
  harnesses: Harness[];
  server: string | null;
  knowledge: boolean;
  /** Set when the workspace could not be reached; items then come from local state only. */
  offline: string | null;
  items: InventoryItem[];
};

const nativeSchema = z.array(
  z.object({
    id: z.string(),
    kind: z.string(),
    harness: z.string(),
    file: z.string(),
    key: z.string(),
  }),
);

const installedSchema = z.array(
  z.object({
    id: z.string(),
    kind: z.string(),
    path: z.string(),
    fingerprint: z.string().optional(),
    versionId: z.string().optional(),
  }),
);

/** What is selected and what is actually installed on this machine. */
export async function inventory(home = homedir()): Promise<Inventory> {
  const settings = await readSettings(home);
  if (!settings) {
    throw new SetupRequiredError();
  }

  const statePath = join(home, ".barndog/state.json");
  const raw = await fileText(statePath);
  const state = await readState(statePath, home);
  const parsed = asRecord(raw ? JSON.parse(raw) : {});
  const native = nativeSchema.parse(parsed.native ?? []);
  const installed = installedSchema.parse(parsed.installed ?? []);
  const conn = settings.connection;
  const localNames = settings.localNames ?? {};
  const linksOf = (id: string) => state.links.filter((l) => l.id === id);
  const nativeOf = (id: string) => native.filter((n) => n.id === id);
  const items: InventoryItem[] = [];
  const seen = new Set<string>();
  // The same comparisons that stop sync, so status can't call these up to date.
  const modified = new Set<string>();
  for (const tree of installed) {
    const actual = await treeFingerprint(tree.path);
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
  const repo = openRepoSource(settings, home, { refresh: "auto" });
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

          const remote = await environmentCatalog(home, conn);

          return {
            catalog: remote.catalog,
            scopes: () =>
              request(
                remote.connection,
                "/v1/scopes",
                z.array(scopeSchema),
                home,
              ),
          };
        })();

      const overlay = localOverlay(settings, home);
      const catalog = overlay
        ? await mergeLocalCatalog(primaryCatalog, overlay)
        : primaryCatalog;

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
          state: !entry.enabled
            ? "disabled"
            : clashed.has(asset.id)
              ? "clash"
              : modified.has(asset.id)
                ? "modified"
                : !present
                  ? "pending"
                  : tree?.versionId && tree.versionId !== asset.publishedVersion
                    ? "outdated"
                    : "installed",
          harnesses,
          paths: [
            ...(tree ? [tree.path] : []),
            ...links.map((l) => l.target),
            ...new Set(entries.map((n) => `${n.file} (${n.key})`)),
          ],
        });
      }

      const scopes = await loadScopes();
      for (const item of items) {
        item.via = item.via.map((label) => {
          const [type, id] = label.split("/");
          const scope = scopes.find(
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

    const name = link
      ? basename(link.target)
      : kind === "mcp"
        ? (entry?.key ?? id)
        : (installed
            .find((t) => t.id === id)
            ?.path.split("/")
            .pop() ?? id);

    items.push({
      id,
      kind,
      name,
      installedName: name,
      origin: "—",
      via: [],
      state: modified.has(id) ? "modified" : offline ? "installed" : "removing",
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
  };
}
