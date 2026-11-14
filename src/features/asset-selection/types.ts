export type AssetKind = "skill" | "mcp" | "hook";

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

/** `localOnly` marks this machine's own folder, shown as the reserved `local` scope. */
export type Origin = (Scope | Readonly<{ type: "dev"; id: string }>) &
  Readonly<{ localOnly?: true }>;

/** Selection metadata only; content models remain specific to each asset kind. */
export type AssetReference = Readonly<{
  kind: AssetKind;
  id: string;
  name: string;
  origin: Origin;
  publishedVersion: string;
}>;

export type Distribution = Readonly<{
  scope: Scope;
  assets: readonly Readonly<{
    assetId: string;
    mode: Exclude<SelectionMode, "all">;
  }>[];
}>;

/** A complete, access-filtered snapshot supplied by the caller. */
export type AssetCatalog = Readonly<{
  assets: readonly AssetReference[];
  distributions: readonly Distribution[];
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

/**
 * Why an asset is selected: picked individually, or supplied by a subscription.
 */
export type Contribution =
  | Readonly<{ type: "individual" }>
  | Readonly<{
      type: "subscription";
      scope: Scope;
      mode: SelectionMode;
      enabled: boolean;
    }>;

/**
 * One selected asset with every reason for its selection. It is enabled unless
 * individually disabled or selected only through disabled subscriptions.
 */
export type EffectiveAsset = Readonly<{
  asset: AssetReference;
  enabled: boolean;
  individuallyDisabled: boolean;
  contributions: readonly Contribution[];
}>;

/** A selection that points at something the catalog no longer has. */
export type SelectionDiagnostic =
  | Readonly<{ type: "missing-scope"; scope: Scope }>
  | Readonly<{ type: "missing-asset"; assetId: string }>;

export type SelectionResult = Readonly<{
  assets: readonly EffectiveAsset[];
  diagnostics: readonly SelectionDiagnostic[];
}>;

export type SelectionAction =
  | Readonly<{ type: "install-scope"; scope: Scope; mode: SelectionMode }>
  | Readonly<{
      type: "switch-team";
      scope: Readonly<{ type: "team"; id: string }>;
      mode: SelectionMode;
    }>
  | Readonly<{
      type: "switch-scope";
      scope: Readonly<{ type: "team" | "repo"; id: string }>;
      mode: SelectionMode;
    }>
  | Readonly<{ type: "remove-scope"; scope: Scope }>
  | Readonly<{ type: "set-scope-enabled"; scope: Scope; enabled: boolean }>
  | Readonly<{ type: "install-asset"; assetId: string }>
  | Readonly<{ type: "remove-asset"; assetId: string }>
  | Readonly<{
      type: "set-asset-enabled";
      assetId: string;
      enabled: boolean;
    }>;

/** An asset whose exclusion or individual disable a change would undo. */
export type OverrideConflict = Readonly<{
  asset: AssetReference;
  excluded: boolean;
  individuallyDisabled: boolean;
}>;

/**
 * What to do with override conflicts: keep or clear them all, or decide per
 * asset.
 */
export type OverrideResolution =
  | Readonly<{ type: "preserve-all" | "clear-all" }>
  | Readonly<{
      type: "per-asset";
      decisions: readonly Readonly<{
        assetId: string;
        choice: "preserve" | "clear";
      }>[];
    }>;

export type SelectionActionResult =
  | Readonly<{ status: "applied"; state: SelectionState }>
  | Readonly<{
      status: "decision-required";
      conflicts: readonly OverrideConflict[];
    }>;
