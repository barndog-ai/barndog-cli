import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { scopeSchema } from "@barndog-ai/api-contract";
import {
  readSettings,
  SetupRequiredError,
  type Settings,
  type SettingsV2,
} from "../../config/settings.js";
import { selectionState, withSelection } from "../../config/environment.js";
import {
  applySelectionAction,
  resolveAssets,
} from "../asset-selection/index.js";
import type {
  AssetCatalog,
  AssetKind,
  OverrideConflict,
  OverrideResolution,
  Scope,
  SelectionAction,
  SelectionDiagnostic,
  SelectionMode,
  SelectionState,
  Subscription,
} from "../asset-selection/types.js";
import type { SyncEvent } from "../skills/sync.js";
import { environmentCatalog, request } from "./remote.js";
import { matchesOrigin } from "../collaboration/remote.js";
import { locked } from "./transaction.js";
import { installedNames, synchronize } from "./sync.js";
import type { WorkspaceSource } from "./source.js";
import { openRepoSource } from "./workspace-source.js";
import {
  localOverlay,
  mergeLocalCatalog,
  withOverlay,
} from "../git-workspace/overlay.js";
import { CliError } from "../../errors.js";
import { originLabel, validInstalledName } from "./names.js";
import { assetKinds } from "../asset-kinds/index.js";

/** How to treat exclusions and disabled assets that a change would undo. */
export type Overrides = {
  /** One choice for every asset. */
  overrides?: "preserve" | "clear";
  /** Path of a JSON file with a choice per asset. */
  decisions?: string;
  /** What the interactive prompt decided. */
  resolution?: OverrideResolution;
};

export type AssetTarget = { kind: AssetKind; name: string; origin?: string };

/** Picker selections, applied in one synchronization. */
export type AssetIds = { kind: AssetKind; ids: string[] };

export type AssetChange = "install" | "remove" | "enable" | "disable";

export type Applied = {
  status: "applied";
  events: SyncEvent[];
  state?: SelectionState;
};

export type DecisionRequired = {
  status: "decision-required";
  conflicts: readonly OverrideConflict[];
};

export type SelectionOutcome = Applied | DecisionRequired;

export type SetsList = {
  available: z.infer<typeof scopeSchema>[];
  subscriptions: readonly Subscription[];
  diagnostics: readonly SelectionDiagnostic[];
};

export type SetPreview = {
  assets: AssetCatalog["assets"][number][];
  selectedAssetIds: string[];
};

async function overrideResolution(
  options: Overrides,
): Promise<OverrideResolution | undefined> {
  if (options.decisions)
    return {
      type: "per-asset",
      decisions: z
        .array(
          z
            .object({
              assetId: z.uuidv4(),
              choice: z.enum(["preserve", "clear"]),
            })
            .strict(),
        )
        .parse(JSON.parse(await readFile(options.decisions, "utf8"))),
    };
  return (
    options.resolution ??
    (options.overrides
      ? {
          type:
            options.overrides === "preserve"
              ? ("preserve-all" as const)
              : ("clear-all" as const),
        }
      : undefined)
  );
}

function assetChange(change: AssetChange, assetId: string): SelectionAction {
  switch (change) {
    case "install":
      return { type: "install-asset", assetId };
    case "remove":
      return { type: "remove-asset", assetId };
    case "enable":
    case "disable":
      return {
        type: "set-asset-enabled",
        assetId,
        enabled: change === "enable",
      };
  }
}

type Workspace = {
  home: string;
  settings: Settings;
  identity: { organizationId: string; developerId?: string };
  catalog: AssetCatalog;
  source?: WorkspaceSource;
  current: SelectionState;
  scopes: () => Promise<z.infer<typeof scopeSchema>[]>;
};

/** Cloud answers these through its API; repo workspaces answer them from files. */
async function workspaceAccess(settings: Settings, home: string) {
  const overlay = localOverlay(settings, home);
  const merge = (catalog: AssetCatalog) =>
    overlay ? mergeLocalCatalog(catalog, overlay) : catalog;
  const source = openRepoSource(settings, home);
  if (source) {
    const model = await source.model();
    return {
      identity: model,
      catalog: await merge(model.catalog),
      source: overlay ? withOverlay(source, overlay) : source,
      scopes: async () => model.scopes,
    };
  }
  const { connection: conn, catalog } = await environmentCatalog(home);
  return {
    identity: conn,
    catalog: await merge(catalog),
    scopes: () => request(conn, "/v1/scopes", z.array(scopeSchema), home),
  };
}

async function readRequiredSettings(home: string) {
  const settings = await readSettings(home);
  if (!settings) throw new SetupRequiredError();
  return settings;
}

function withLockedWorkspace<T>(
  home: string,
  operation: (workspace: Workspace) => Promise<T>,
): Promise<T> {
  return locked(home, async () => {
    const settings = await readRequiredSettings(home);
    const access = await workspaceAccess(settings, home);
    return operation({
      ...access,
      home,
      settings,
      current: selectionState(settings),
    });
  });
}

async function syncSelection(
  workspace: Workspace,
  state: SelectionState,
  next: SettingsV2 = withSelection(workspace.settings, state),
): Promise<Applied> {
  return {
    status: "applied",
    events: await synchronize(undefined, workspace.home, next, {
      catalog: workspace.catalog,
      source: workspace.source,
    }),
    state,
  };
}

async function applyChange(
  workspace: Workspace,
  change: SelectionAction,
  overrides: Overrides,
  origin: string | undefined,
): Promise<SelectionOutcome> {
  const resolution = await overrideResolution(overrides);
  const result = (() => {
    try {
      return applySelectionAction(
        workspace.catalog,
        workspace.current,
        change,
        resolution,
      );
    } catch (error) {
      if ((error as Error).message.startsWith("Scope is not selected"))
        throw new CliError(
          `${origin} isn't in your sets yet.`,
          `barndog sets install ${origin}`,
          { cause: error },
        );
      throw error;
    }
  })();
  if (result.status === "decision-required") return result;
  return syncSelection(workspace, result.state);
}

/**
 * The asset `target` names for `change`. Anything but install also accepts the
 * UUID of an asset that's no longer in the catalog, so it can still be cleaned up.
 */
function assetId(
  workspace: Workspace,
  target: AssetTarget,
  change: AssetChange | "rename",
) {
  const { settings, catalog, identity } = workspace;
  const command = `barndog ${assetKinds[target.kind].command} ${change}`;
  const localNames = settings.version === 2 ? (settings.localNames ?? {}) : {};
  const named = catalog.assets.filter(
    (a) =>
      a.kind === target.kind &&
      (a.id === target.name ||
        a.name === target.name ||
        localNames[a.id] === target.name),
  );
  const matches = target.origin
    ? named.filter((a) => matchesOrigin(a.origin, target.origin!, identity))
    : named;
  const staleId =
    change !== "install" && z.uuidv4().safeParse(target.name).success
      ? target.name
      : undefined;
  const id = matches.length === 1 ? matches[0]!.id : staleId;
  if (!id && matches.length > 1)
    throw new CliError(
      `${target.name} exists in several scopes: ${matches.map((a) => originLabel(a.origin)).join(", ")}. Choose one with --origin.`,
      `${command} ${target.name} --origin ${originLabel(matches[0]!.origin)}`,
    );
  if (!id)
    throw new CliError(
      `No ${assetKinds[target.kind].one} named ${target.name}${target.origin ? ` in ${target.origin}` : ""} is available to you.`,
      `barndog ${assetKinds[target.kind].command} search ${target.name}`,
    );
  return id;
}

export function changeAsset(
  change: AssetChange,
  target: AssetTarget & Overrides,
  home = homedir(),
): Promise<SelectionOutcome> {
  return withLockedWorkspace(home, async (workspace) => {
    const id = assetId(workspace, target, change);
    return applyChange(
      workspace,
      assetChange(change, id),
      target,
      target.origin,
    );
  });
}

export function changeAssets(
  change: AssetChange,
  target: AssetIds & Overrides,
  home = homedir(),
): Promise<SelectionOutcome> {
  return withLockedWorkspace(home, async (workspace) => {
    if (!target.ids.length) return { status: "applied", events: [] };
    const resolution = await overrideResolution(target);
    let state = workspace.current;
    for (const id of target.ids) {
      const result = applySelectionAction(
        workspace.catalog,
        state,
        assetChange(change, id),
        resolution,
      );
      if (result.status === "decision-required") return result;
      state = result.state;
    }
    return syncSelection(workspace, state);
  });
}

/** `reset`, or `as` set to the published name, drops the local name. */
export function renameAsset(
  target: AssetTarget & { as?: string; reset?: boolean },
  home = homedir(),
): Promise<Applied> {
  return withLockedWorkspace(home, async (workspace) => {
    const { settings, catalog, current } = workspace;
    const id = assetId(workspace, target, "rename");
    const asset = catalog.assets.find((a) => a.id === id);
    const names = {
      ...(settings.version === 2 ? (settings.localNames ?? {}) : {}),
    };
    if (target.reset || target.as === asset?.name) delete names[id];
    else {
      const name = target.as ?? "";
      if (!validInstalledName(name))
        throw new CliError(
          "Use lowercase letters, numbers and single hyphens (at most 64 characters).",
        );
      const held = await installedNames(workspace.home);
      const taken = catalog.assets.find(
        (a) =>
          a.id !== id &&
          a.kind === target.kind &&
          ((names[a.id] ?? a.name) === name || held(a.id) === name) &&
          resolveAssets(catalog, current).assets.some(
            (entry) => entry.asset.id === a.id && entry.enabled,
          ),
      );
      if (taken)
        throw new CliError(
          `${name} is already used by ${originLabel(taken.origin)}.`,
        );
      names[id] = name;
    }
    const next: SettingsV2 = withSelection(settings, current);
    if (Object.keys(names).length) next.localNames = names;
    else delete next.localNames;
    return syncSelection(workspace, current, next);
  });
}

export function listSets(home = homedir()): Promise<SetsList> {
  return withLockedWorkspace(home, async ({ scopes, current, catalog }) => ({
    available: (await scopes()).filter((s) => s.type !== "dev"),
    subscriptions: current.subscriptions,
    diagnostics: resolveAssets(catalog, current).diagnostics,
  }));
}

/** Removal also accepts the UUID of a scope you can no longer see, such as `team/<uuid>`. */
async function findScope(
  workspace: Workspace,
  selector: string,
  { forRemoval = false } = {},
): Promise<Scope> {
  const matches = (await workspace.scopes()).filter(
    (s) => s.type !== "dev" && matchesOrigin(s, selector, workspace.identity),
  );
  const [match] = matches;
  if (matches.length === 1 && match && match.type !== "dev")
    return { type: match.type, id: match.id };
  const [type, id] = selector.split(/[/:]/);
  if (
    !forRemoval ||
    (type !== "org" && type !== "team" && type !== "repo") ||
    !z.uuidv4().safeParse(id).success
  )
    throw new CliError(
      `No scope named ${selector} is available to you. To remove an unavailable subscription, pass its UUID, such as team/<uuid>.`,
      "barndog sets list",
    );
  return { type, id: id! };
}

function scopeAssets(workspace: Workspace, scope: Scope) {
  const distribution = workspace.catalog.distributions.find(
    (d) => d.scope.type === scope.type && d.scope.id === scope.id,
  );
  if (!distribution) throw new Error("Scope distribution unavailable");
  return workspace.catalog.assets.filter((asset) =>
    distribution.assets.some((entry) => entry.assetId === asset.id),
  );
}

export function previewSet(
  origin: string,
  home = homedir(),
): Promise<SetPreview> {
  return withLockedWorkspace(home, async (workspace) => ({
    assets: scopeAssets(workspace, await findScope(workspace, origin)),
    selectedAssetIds: resolveAssets(
      workspace.catalog,
      workspace.current,
    ).assets.map((entry) => entry.asset.id),
  }));
}

export function installSet(
  options: { origin: string; mode?: SelectionMode } & Overrides,
  home = homedir(),
): Promise<SelectionOutcome> {
  return withLockedWorkspace(home, async (workspace) =>
    applyChange(
      workspace,
      {
        type: "install-scope",
        scope: await findScope(workspace, options.origin),
        mode: options.mode ?? "recommended",
      },
      options,
      options.origin,
    ),
  );
}

/**
 * Selects some of a scope's assets individually instead of subscribing, so the
 * selection doesn't follow later additions to the scope.
 */
export function installSetAssets(
  options: { origin: string; assetIds: string[] },
  home = homedir(),
): Promise<Applied> {
  return withLockedWorkspace(home, async (workspace) => {
    const scope = await findScope(workspace, options.origin);
    const available = scopeAssets(workspace, scope);
    const ids = z.array(z.uuidv4()).parse(options.assetIds);
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => !available.some((asset) => asset.id === id))
    )
      throw new Error(
        "Custom selection contains duplicate or unavailable assets",
      );
    if (!ids.length) return { status: "applied", events: [] };
    let state: SelectionState = {
      ...workspace.current,
      subscriptions: workspace.current.subscriptions.filter(
        (s) => s.scope.type !== scope.type || s.scope.id !== scope.id,
      ),
    };
    for (const assetId of ids) {
      const result = applySelectionAction(workspace.catalog, state, {
        type: "install-asset",
        assetId,
      });
      if (result.status !== "applied")
        throw new Error("Individual installation needs a decision");
      state = result.state;
    }
    return syncSelection(workspace, state);
  });
}

export function changeSet(
  change: "remove" | "enable" | "disable",
  options: { origin: string } & Overrides,
  home = homedir(),
): Promise<SelectionOutcome> {
  return withLockedWorkspace(home, async (workspace) => {
    const scope = await findScope(workspace, options.origin, {
      forRemoval: change === "remove",
    });
    return applyChange(
      workspace,
      change === "remove"
        ? { type: "remove-scope", scope }
        : { type: "set-scope-enabled", scope, enabled: change === "enable" },
      options,
      options.origin,
    );
  });
}

/** Replaces the subscriptions of the same type (team or repository). */
export function switchSet(
  options: { origin: string; mode?: SelectionMode } & Overrides,
  home = homedir(),
): Promise<SelectionOutcome> {
  return withLockedWorkspace(home, async (workspace) => {
    const scope = await findScope(workspace, options.origin);
    if (scope.type !== "team" && scope.type !== "repo")
      throw new CliError(
        "Switch between teams or repositories, such as team/engineering or repo/web-app.",
      );
    return applyChange(
      workspace,
      {
        type: "switch-scope",
        scope: { type: scope.type, id: scope.id },
        mode: options.mode ?? "recommended",
      },
      options,
      options.origin,
    );
  });
}

/** Whether coding tools are told at session start which knowledge documents exist. */
export function setKnowledge(
  enabled: boolean,
  home = homedir(),
): Promise<Applied> {
  return locked(home, async () => {
    const settings = await readRequiredSettings(home);
    if (
      settings.version !== 2 ||
      (!settings.connection &&
        !settings.gitWorkspace &&
        !settings.localWorkspace)
    )
      throw new Error("Set up a workspace with barndog init first");
    return {
      status: "applied",
      events: await synchronize(undefined, home, {
        ...settings,
        knowledge: enabled,
      }),
    };
  });
}
