export type AssetKind = "skill" | "mcp" | "hook";

export type SelectionMode = "recommended" | "optional" | "all";

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

export type Subscription = Readonly<{
  scope: Scope;
  mode: SelectionMode;
  enabled: boolean;
}>;

export type SelectionState = Readonly<{
  subscriptions: readonly Subscription[];
  individualAssetIds: readonly string[];
  excludedAssetIds: readonly string[];
  disabledAssetIds: readonly string[];
}>;

export type Contribution =
  | Readonly<{ type: "individual" }>
  | Readonly<{
      type: "subscription";
      scope: Scope;
      mode: SelectionMode;
      enabled: boolean;
    }>;

export type EffectiveAsset = Readonly<{
  asset: AssetReference;
  enabled: boolean;
  individuallyDisabled: boolean;
  contributions: readonly Contribution[];
}>;

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

export type OverrideConflict = Readonly<{
  asset: AssetReference;
  excluded: boolean;
  individuallyDisabled: boolean;
}>;

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
