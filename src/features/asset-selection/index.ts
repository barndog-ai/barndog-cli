import type {
  AssetCatalog,
  AssetReference,
  Contribution,
  Distribution,
  EffectiveAsset,
  Origin,
  OverrideResolution,
  SelectionAction,
  SelectionActionResult,
  SelectionDiagnostic,
  SelectionResult,
} from "./types.js";
import type {
  Scope,
  SelectionMode,
  SelectionState,
} from "../../config/selection.js";
import { defined } from "../../shared/lookup.js";
import { UUID_V4 } from "../../shared/patterns.js";

/**
 * Enabling or disabling a set that isn't in the selection. Callers that know
 * the origin the person typed turn it into a `CliError` with the install
 * command.
 */
export class ScopeNotSelectedError extends Error {
  readonly scope: string;

  constructor(scope: string) {
    super(`Scope is not selected: ${scope}`);
    this.name = "ScopeNotSelectedError";
    this.scope = scope;
  }
}

export type * from "./types.js";

function id(value: string): string {
  if (!UUID_V4.test(value)) {
    throw new Error(`Expected UUIDv4: ${value}`);
  }

  return value.toLowerCase();
}

function origin<T extends Origin>(value: T): T {
  return { ...value, id: id(value.id) };
}

function scopeKey(scope: Scope): string {
  return `${scope.type}:${scope.id}`;
}

function compare(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
}

function ids(values: readonly string[]): string[] {
  return [...new Set(values.map(id))].sort(compare);
}

function normalizeState(state: SelectionState): SelectionState {
  const subscriptions = state.subscriptions.map((subscription) => ({
    ...subscription,
    scope: origin(subscription.scope),
  }));

  const keys = subscriptions.map((subscription) =>
    scopeKey(subscription.scope),
  );

  if (new Set(keys).size !== keys.length) {
    throw new Error("Only one subscription per scope is allowed");
  }

  return {
    subscriptions: subscriptions.sort((a, b) =>
      compare(scopeKey(a.scope), scopeKey(b.scope)),
    ),
    individualAssetIds: ids(state.individualAssetIds),
    excludedAssetIds: ids(state.excludedAssetIds),
    disabledAssetIds: ids(state.disabledAssetIds),
  };
}

function prepare(catalog: AssetCatalog, input: SelectionState) {
  const assets = new Map<string, AssetReference>();
  for (const asset of catalog.assets) {
    const assetId = id(asset.id);
    if (assets.has(assetId)) {
      throw new Error(`Duplicate catalogue asset ID: ${assetId}`);
    }

    assets.set(assetId, {
      ...asset,
      id: assetId,
      origin: origin(asset.origin),
    });
  }

  const distributions = new Map<string, Distribution>();
  for (const distribution of catalog.distributions) {
    const scope = origin(distribution.scope);
    const key = scopeKey(scope);
    if (distributions.has(key)) {
      throw new Error(`Duplicate distribution scope: ${key}`);
    }

    const entries = new Map<string, "recommended" | "optional">();
    for (const entry of distribution.assets) {
      const assetId = id(entry.assetId);
      const previous = entries.get(assetId);
      if (previous && previous !== entry.mode) {
        throw new Error(
          `Conflicting recommendation modes: ${assetId} in ${key}`,
        );
      }

      entries.set(assetId, entry.mode);
    }

    distributions.set(key, {
      scope,
      assets: [...entries]
        .sort(([a], [b]) => compare(a, b))
        .map(([assetId, mode]) => ({ assetId, mode })),
    });
  }

  return { assets, distributions, state: normalizeState(input) };
}

function matches(
  mode: SelectionMode,
  entryMode: "recommended" | "optional",
): boolean {
  return mode === "all" || mode === entryMode;
}

/** Calculate desired local installation and activation without changing saved choices. */
export function resolveAssets(
  catalog: AssetCatalog,
  input: SelectionState,
): SelectionResult {
  const { assets, distributions, state } = prepare(catalog, input);
  const excluded = new Set(state.excludedAssetIds);
  const disabled = new Set(state.disabledAssetIds);
  const contributions = new Map<string, Contribution[]>();
  const diagnostics: SelectionDiagnostic[] = [];
  const missingAssets = new Set<string>();

  function contribute(assetId: string, contribution: Contribution) {
    if (!assets.has(assetId)) {
      missingAssets.add(assetId);

      return;
    }

    if (excluded.has(assetId)) {
      return;
    }

    const sources = contributions.get(assetId) ?? [];
    sources.push(contribution);
    contributions.set(assetId, sources);
  }

  for (const subscription of state.subscriptions) {
    const distribution = distributions.get(scopeKey(subscription.scope));
    if (!distribution) {
      diagnostics.push({ type: "missing-scope", scope: subscription.scope });
      continue;
    }

    for (const entry of distribution.assets) {
      if (matches(subscription.mode, entry.mode)) {
        contribute(entry.assetId, { type: "subscription", ...subscription });
      }
    }
  }

  for (const assetId of state.individualAssetIds) {
    contribute(assetId, { type: "individual" });
  }

  for (const assetId of [...missingAssets].sort(compare)) {
    diagnostics.push({ type: "missing-asset", assetId });
  }

  const effective: EffectiveAsset[] = [...contributions]
    .sort(([a], [b]) => compare(a, b))
    .map(([assetId, sources]) => ({
      asset: defined(
        assets.get(assetId),
        `Asset ${assetId} is missing from the catalog`,
      ),
      enabled:
        !disabled.has(assetId) &&
        sources.some(
          (source) => source.type === "individual" || source.enabled,
        ),
      individuallyDisabled: disabled.has(assetId),
      contributions: sources,
    }));

  return { assets: effective, diagnostics };
}

/** Apply an explicit user action atomically; unresolved overrides never partially apply. */
export function applySelectionAction(
  catalog: AssetCatalog,
  input: SelectionState,
  action: SelectionAction,
  resolution?: OverrideResolution,
): SelectionActionResult {
  const { assets, distributions, state } = prepare(catalog, input);
  let subscriptions = [...state.subscriptions];
  const individual = new Set(state.individualAssetIds);
  const excluded = new Set(state.excludedAssetIds);
  const disabled = new Set(state.disabledAssetIds);
  if ("scope" in action) {
    const scope = origin(action.scope);
    const key = scopeKey(scope);
    if (
      action.type === "install-scope" ||
      action.type === "switch-team" ||
      action.type === "switch-scope"
    ) {
      const distribution = distributions.get(key);
      if (!distribution) {
        throw new Error(`Unknown scope: ${key}`);
      }

      const conflicts = distribution.assets
        .filter((entry) => matches(action.mode, entry.mode))
        .filter(
          (entry) => excluded.has(entry.assetId) || disabled.has(entry.assetId),
        )
        .map((entry) => {
          const asset = assets.get(entry.assetId);
          if (!asset) {
            throw new Error(
              `Cannot resolve overrides for missing asset: ${entry.assetId}`,
            );
          }

          return {
            asset,
            excluded: excluded.has(entry.assetId),
            individuallyDisabled: disabled.has(entry.assetId),
          };
        });

      const decisions = new Map<string, "preserve" | "clear">();
      if (resolution?.type === "per-asset") {
        for (const decision of resolution.decisions) {
          const assetId = id(decision.assetId);
          if (decisions.has(assetId)) {
            throw new Error(`Duplicate override decision: ${assetId}`);
          }

          decisions.set(assetId, decision.choice);
        }
      }

      if (
        conflicts.length &&
        (!resolution ||
          (resolution.type === "per-asset" &&
            conflicts.some(({ asset }) => !decisions.has(asset.id))))
      ) {
        return { status: "decision-required", conflicts };
      }

      for (const { asset } of conflicts) {
        if (
          resolution?.type === "clear-all" ||
          decisions.get(asset.id) === "clear"
        ) {
          excluded.delete(asset.id);
          disabled.delete(asset.id);
        }
      }

      subscriptions = subscriptions.filter((subscription) =>
        action.type === "switch-team" || action.type === "switch-scope"
          ? subscription.scope.type !== scope.type
          : scopeKey(subscription.scope) !== key,
      );

      subscriptions.push({ scope, mode: action.mode, enabled: true });
    } else if (action.type === "remove-scope") {
      subscriptions = subscriptions.filter(
        (subscription) => scopeKey(subscription.scope) !== key,
      );
    } else {
      if (
        !subscriptions.some(
          (subscription) => scopeKey(subscription.scope) === key,
        )
      ) {
        throw new ScopeNotSelectedError(key);
      }

      subscriptions = subscriptions.map((subscription) =>
        scopeKey(subscription.scope) === key
          ? { ...subscription, enabled: action.enabled }
          : subscription,
      );
    }
  } else {
    const assetId = id(action.assetId);
    if (action.type === "install-asset") {
      if (!assets.has(assetId)) {
        throw new Error(`Unknown asset: ${assetId}`);
      }

      individual.add(assetId);
      excluded.delete(assetId);
      disabled.delete(assetId);
    } else if (action.type === "remove-asset") {
      individual.delete(assetId);
      excluded.add(assetId);
    } else if (action.enabled) {
      disabled.delete(assetId);
    } else {
      disabled.add(assetId);
    }
  }

  return {
    status: "applied",
    state: normalizeState({
      subscriptions,
      individualAssetIds: [...individual],
      excludedAssetIds: [...excluded],
      disabledAssetIds: [...disabled],
    }),
  };
}
