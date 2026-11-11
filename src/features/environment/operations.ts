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
  OverrideResolution,
  SelectionAction,
} from "../asset-selection/types.js";
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

export type EnvironmentOptions = {
  kind?: AssetKind;
  name?: string;
  origin?: string;
  team?: string;
  mode?: "recommended" | "optional" | "all";
  resolution?: OverrideResolution;
  overrides?: "preserve" | "clear";
  decisions?: string;
  assetIds?: string[];
  as?: string;
  reset?: boolean;
  ids?: string[];
};

async function overrideResolution(
  options: EnvironmentOptions,
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

function assetChange(action: string, assetId: string): SelectionAction {
  if (action === "install") return { type: "install-asset", assetId };
  if (action === "remove") return { type: "remove-asset", assetId };
  if (action === "enable" || action === "disable")
    return {
      type: "set-asset-enabled",
      assetId,
      enabled: action === "enable",
    };
  throw new Error(`Unknown environment action: ${action}`);
}

type WorkspaceAccess = {
  identity: { organizationId: string; developerId?: string };
  catalog: AssetCatalog;
  source?: WorkspaceSource;
  scopes: () => Promise<z.infer<typeof scopeSchema>[]>;
};

/** Cloud answers these through its API; repo workspaces answer them from files. */
async function workspaceAccess(
  settings: Settings,
  home: string,
): Promise<WorkspaceAccess> {
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

export async function environmentOperation(
  action: string,
  options: EnvironmentOptions = {},
  home = homedir(),
): Promise<unknown> {
  return locked(home, async () => {
    const settings = await readSettings(home);
    if (!settings) throw new SetupRequiredError();
    if (action === "knowledge-enable" || action === "knowledge-disable") {
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
          knowledge: action === "knowledge-enable",
        }),
      };
    }
    const access = await workspaceAccess(settings, home);
    const { identity: conn, catalog } = access;
    const known = { catalog, source: access.source };
    const current = selectionState(settings);
    if (action === "list")
      return catalog.assets.filter(
        (a) => !options.kind || a.kind === options.kind,
      );
    if (action === "status") return resolveAssets(catalog, current);
    // Picker selections arrive as IDs and apply in one synchronization.
    if (
      options.ids?.length &&
      ["install", "remove", "enable", "disable"].includes(action)
    ) {
      const resolution = await overrideResolution(options);
      let state = current;
      for (const assetId of options.ids) {
        const result = applySelectionAction(
          catalog,
          state,
          assetChange(action, assetId),
          resolution,
        );
        if (result.status === "decision-required") return result;
        state = result.state;
      }
      return {
        status: "applied",
        events: await synchronize(
          undefined,
          home,
          withSelection(settings, state),
          known,
        ),
        state,
      };
    }
    const scopes = await access.scopes();
    if (action === "sets-list")
      return {
        available: scopes.filter((s) => s.type !== "dev"),
        subscriptions: current.subscriptions,
        diagnostics: resolveAssets(catalog, current).diagnostics,
      };
    let change: SelectionAction;
    if (
      action.startsWith("sets-") ||
      action === "switch-team" ||
      action === "switch"
    ) {
      const selector =
        action === "switch-team" ? `team/${options.team}` : options.origin!;
      const matches = scopes.filter(
        (s) => s.type !== "dev" && matchesOrigin(s, selector, conn),
      );
      let scope: { type: "org" | "team" | "repo"; id: string };
      if (matches.length === 1 && matches[0]!.type !== "dev")
        scope = { type: matches[0]!.type, id: matches[0]!.id };
      else {
        const [type, id] = selector.split(/[/:]/);
        if (
          !action.endsWith("remove") ||
          !["org", "team", "repo"].includes(type ?? "") ||
          !z.uuidv4().safeParse(id).success
        )
          throw new CliError(
            `No scope named ${selector} is available to you. To remove an unavailable subscription, pass its UUID, such as team/<uuid>.`,
            "barndog sets list",
          );
        scope = { type: type as "org" | "team" | "repo", id: id! };
      }
      if (action === "sets-preview" || action === "sets-install-custom") {
        const distribution = catalog.distributions.find(
          (d) => d.scope.type === scope.type && d.scope.id === scope.id,
        );
        if (!distribution) throw new Error("Scope distribution unavailable");
        const available = catalog.assets.filter((asset) =>
          distribution.assets.some((entry) => entry.assetId === asset.id),
        );
        if (action === "sets-preview")
          return {
            assets: available,
            selectedAssetIds: resolveAssets(catalog, current).assets.map(
              (entry) => entry.asset.id,
            ),
          };
        const ids = z.array(z.uuidv4()).parse(options.assetIds);
        if (
          new Set(ids).size !== ids.length ||
          ids.some((id) => !available.some((asset) => asset.id === id))
        )
          throw new Error(
            "Custom selection contains duplicate or unavailable assets",
          );
        if (!ids.length) return { status: "applied", events: [] };
        let state: import("../asset-selection/types.js").SelectionState = {
          ...current,
          subscriptions: current.subscriptions.filter(
            (s) => s.scope.type !== scope.type || s.scope.id !== scope.id,
          ),
        };
        for (const assetId of ids) {
          const result = applySelectionAction(catalog, state, {
            type: "install-asset",
            assetId,
          });
          if (result.status !== "applied")
            throw new Error("Individual installation needs a decision");
          state = result.state;
        }
        return {
          status: "applied",
          events: await synchronize(
            undefined,
            home,
            withSelection(settings, state),
            known,
          ),
          state,
        };
      }
      if (action === "switch") {
        if (scope.type !== "team" && scope.type !== "repo")
          throw new CliError(
            "Switch between teams or repositories, such as team/engineering or repo/web-app.",
          );
        change = {
          type: "switch-scope",
          scope: { type: scope.type, id: scope.id },
          mode: options.mode ?? "recommended",
        };
      } else if (action === "switch-team") {
        if (scope.type !== "team") throw new Error("A team scope is required");
        change = {
          type: "switch-team",
          scope: { type: "team", id: scope.id },
          mode: options.mode ?? "recommended",
        };
      } else if (action === "sets-install")
        change = {
          type: "install-scope",
          scope,
          mode: options.mode ?? "recommended",
        };
      else if (action === "sets-remove")
        change = { type: "remove-scope", scope };
      else
        change = {
          type: "set-scope-enabled",
          scope,
          enabled: action === "sets-enable",
        };
    } else {
      const localNames =
        settings.version === 2 ? (settings.localNames ?? {}) : {};
      const named = catalog.assets.filter(
        (a) =>
          a.kind === options.kind &&
          (a.id === options.name ||
            a.name === options.name ||
            localNames[a.id] === options.name),
      );
      const matches = options.origin
        ? named.filter((a) => matchesOrigin(a.origin, options.origin!, conn))
        : named;
      const staleId =
        action !== "install" && z.uuidv4().safeParse(options.name).success
          ? options.name
          : undefined;
      const id = matches.length === 1 ? matches[0]!.id : staleId;
      const command = `barndog ${options.kind === "skill" ? "skills" : options.kind === "mcp" ? "mcp" : "hooks"} ${action}`;
      if (!id && matches.length > 1)
        throw new CliError(
          `${options.name} exists in several scopes: ${matches.map((a) => originLabel(a.origin)).join(", ")}. Choose one with --origin.`,
          `${command} ${options.name} --origin ${originLabel(matches[0]!.origin)}`,
        );
      if (!id)
        throw new CliError(
          `No ${options.kind === "mcp" ? "MCP server" : options.kind} named ${options.name}${options.origin ? ` in ${options.origin}` : ""} is available to you.`,
          `barndog ${options.kind === "skill" ? "skills" : options.kind === "mcp" ? "mcp" : "hooks"} search ${options.name}`,
        );
      if (action === "rename") {
        const asset = catalog.assets.find((a) => a.id === id);
        const names = { ...localNames };
        if (options.reset || options.as === asset?.name) delete names[id];
        else {
          const name = options.as ?? "";
          if (!validInstalledName(name))
            throw new CliError(
              "Use lowercase letters, numbers and single hyphens (at most 64 characters).",
            );
          const held = await installedNames(home);
          const taken = catalog.assets.find(
            (a) =>
              a.id !== id &&
              a.kind === options.kind &&
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
        return {
          status: "applied",
          events: await synchronize(undefined, home, next, known),
          state: current,
        };
      }
      change = assetChange(action, id);
    }
    const resolution = await overrideResolution(options);
    const result = (() => {
      try {
        return applySelectionAction(catalog, current, change, resolution);
      } catch (error) {
        if ((error as Error).message.startsWith("Scope is not selected"))
          throw new CliError(
            `${options.origin} isn't in your sets yet.`,
            `barndog sets install ${options.origin}`,
            { cause: error },
          );
        throw error;
      }
    })();
    if (result.status === "decision-required") return result;
    const next = withSelection(settings, result.state);
    return {
      status: "applied",
      events: await synchronize(undefined, home, next, known),
      state: result.state,
    };
  });
}
