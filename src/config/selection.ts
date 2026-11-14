import { z } from "zod";

// The asset kinds and the selection that config.yaml and state.json persist.
// Features build on these; they live here so config/ depends on no feature.

export type AssetKind = "skill" | "mcp" | "hook";

/** Kinds published as a folder of files; MCP configurations are a single definition. */
export type PackageKind = Exclude<AssetKind, "mcp">;

/**
 * Asset kinds delivered as file packages; MCP definitions use separate
 * configuration handling.
 */
export const packageKindList = [
  "skill",
  "hook",
] as const satisfies readonly PackageKind[];

/** The folder each kind lives in, in a workspace and under ~/.barndog/installed/. */
export const assetFolders: Record<AssetKind, string> = {
  skill: "skills",
  mcp: "mcp",
  hook: "hooks",
};

/**
 * Which of a scope's assets a subscription takes: those it marks `recommended`,
 * those it marks `optional`, or `all`. Distributions mark each asset
 * recommended or optional.
 */
export type SelectionMode = "recommended" | "optional" | "all";

/**
 * A subscribable scope: the organization, a team or a repository. Personal
 * (`dev`) scopes can't be subscribed to, only picked from.
 */
export type Scope = Readonly<{
  type: "org" | "team" | "repo";
  id: string;
}>;

/**
 * A disabled subscription stays saved and keeps its assets selected, but does
 * not enable them on its own.
 */
export type Subscription = Readonly<{
  scope: Scope;
  mode: SelectionMode;
  enabled: boolean;
}>;

/**
 * Persisted environment choices in config.yaml: subscriptions, individual
 * picks, exclusions and individually disabled assets. IDs must be UUIDv4.
 */
export type SelectionState = Readonly<{
  subscriptions: readonly Subscription[];
  individualAssetIds: readonly string[];
  excludedAssetIds: readonly string[];
  disabledAssetIds: readonly string[];
}>;

const id = z.uuidv4().transform((value) => value.toLowerCase());

export const selectionStateSchema = z
  .object({
    subscriptions: z.array(
      z
        .object({
          scope: z.object({ type: z.enum(["org", "team", "repo"]), id }),
          mode: z.enum(["recommended", "optional", "all"]),
          enabled: z.boolean(),
        })
        .strict(),
    ),
    individualAssetIds: z.array(id),
    excludedAssetIds: z.array(id),
    disabledAssetIds: z.array(id),
  })
  .strict();
