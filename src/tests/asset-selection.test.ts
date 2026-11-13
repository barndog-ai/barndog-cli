import { expect, test } from "vitest";
import {
  applySelectionAction,
  resolveAssets,
  type AssetCatalog,
  type AssetKind,
  type AssetReference,
  type OverrideResolution,
  type Scope,
  type SelectionAction,
  type SelectionMode,
  type SelectionState,
  type Subscription,
} from "../features/asset-selection/index.js";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const org: Scope = { type: "org", id: uuid(100) };
const frontend = { type: "team", id: uuid(101) } as const;
const platform = { type: "team", id: uuid(102) } as const;
const repo: Scope = { type: "repo", id: uuid(103) };
const personal = { type: "dev", id: uuid(104) } as const;
const a = uuid(1),
  b = uuid(2),
  c = uuid(3),
  d = uuid(4);

function asset(id: string, kind: AssetKind = "skill"): AssetReference {
  return { id, kind, name: "review", origin: org, publishedVersion: "v1" };
}

function state(patch: Partial<SelectionState> = {}): SelectionState {
  return {
    subscriptions: [],
    individualAssetIds: [],
    excludedAssetIds: [],
    disabledAssetIds: [],
    ...patch,
  };
}

function subscription(
  scope: Scope,
  mode: SelectionMode = "all",
  enabled = true,
): Subscription {
  return { scope, mode, enabled };
}

function catalog(kind: AssetKind = "skill"): AssetCatalog {
  return {
    assets: [
      asset(a, kind),
      asset(b, kind),
      asset(c, kind),
      { ...asset(d, kind), origin: personal },
    ],
    distributions: [
      {
        scope: org,
        assets: [
          { assetId: a, mode: "recommended" },
          { assetId: b, mode: "optional" },
        ],
      },
      {
        scope: frontend,
        assets: [
          { assetId: a, mode: "recommended" },
          { assetId: c, mode: "optional" },
        ],
      },
      { scope: platform, assets: [{ assetId: a, mode: "optional" }] },
      { scope: repo, assets: [{ assetId: c, mode: "recommended" }] },
    ],
  };
}

function apply(
  input: SelectionState,
  action: SelectionAction,
  resolution?: OverrideResolution,
  snapshot = catalog(),
): SelectionState {
  const result = applySelectionAction(snapshot, input, action, resolution);
  expect(result.status).toBe("applied");
  if (result.status !== "applied") {
    throw new Error("Expected action to apply");
  }

  return result.state;
}

function selected(input: SelectionState, snapshot = catalog()) {
  return resolveAssets(snapshot, input).assets.map(({ asset, enabled }) => [
    asset.id,
    enabled,
  ]);
}

for (const kind of ["skill", "mcp", "hook"] as const) {
  for (const [mode, expected] of [
    ["recommended", [a]],
    ["optional", [b]],
    ["all", [a, b]],
  ] as const) {
    test(`${kind}: ${mode} selects only matching distribution entries`, () => {
      const result = resolveAssets(
        catalog(kind),
        state({ subscriptions: [subscription(org, mode)] }),
      );

      expect(result.assets.map((entry) => entry.asset.id)).toStrictEqual(
        expected,
      );

      expect(
        result.assets.every(
          (entry) => entry.enabled && entry.asset.kind === kind,
        ),
      ).toBeTruthy();
    });
  }

  test(`${kind}: empty state never installs recommendations or owning-team assets`, () => {
    expect(resolveAssets(catalog(kind), state())).toStrictEqual({
      assets: [],
      diagnostics: [],
    });
  });

  test(`${kind}: overlapping sources deduplicate by UUID and preserve every contribution`, () => {
    const result = resolveAssets(
      catalog(kind),
      state({
        subscriptions: [subscription(frontend), subscription(platform)],
        individualAssetIds: [a, d],
      }),
    );

    expect(result.assets.map((entry) => entry.asset.id)).toStrictEqual([
      a,
      c,
      d,
    ]);

    expect(result.assets[0]!.contributions.length).toBe(3);
    expect(result.assets[0]!.asset.name).toBe(result.assets[1]!.asset.name);
    expect(result.assets[2]!.asset.origin.type).toBe("dev");
  });

  test(`${kind}: disabled subscriptions keep installation intent and another source can enable`, () => {
    const input = state({
      subscriptions: [subscription(org, "all", false), subscription(platform)],
    });

    expect(selected(input, catalog(kind))).toStrictEqual([
      [a, true],
      [b, false],
    ]);

    expect(
      selected({ ...input, individualAssetIds: [b] }, catalog(kind)),
    ).toStrictEqual([
      [a, true],
      [b, true],
    ]);
  });

  test(`${kind}: individual disable wins over all sources and enabling clears only that override`, () => {
    const input = state({
      subscriptions: [subscription(org)],
      individualAssetIds: [a],
      disabledAssetIds: [a],
    });

    expect(selected(input, catalog(kind))).toStrictEqual([
      [a, false],
      [b, true],
    ]);

    const enabled = apply(
      input,
      { type: "set-asset-enabled", assetId: a, enabled: true },
      undefined,
      catalog(kind),
    );

    expect(selected(enabled, catalog(kind))).toStrictEqual([
      [a, true],
      [b, true],
    ]);
  });

  test(`${kind}: removal excludes every source; explicit reinstall follows the individual asset`, () => {
    const input = state({
      subscriptions: [subscription(org), subscription(frontend)],
      individualAssetIds: [a],
      disabledAssetIds: [a],
    });

    const removed = apply(
      input,
      { type: "remove-asset", assetId: a },
      undefined,
      catalog(kind),
    );

    expect(removed.individualAssetIds).toStrictEqual([]);
    expect(selected(removed, catalog(kind))).toStrictEqual([
      [b, true],
      [c, true],
    ]);

    const installed = apply(
      removed,
      { type: "install-asset", assetId: a },
      undefined,
      catalog(kind),
    );

    expect(installed.excludedAssetIds).toStrictEqual([]);
    expect(installed.disabledAssetIds).toStrictEqual([]);
    expect(selected(installed, catalog(kind))[0]![1]).toBe(true);
    expect(installed.individualAssetIds).toStrictEqual([a]);
  });
}

test("one mixed scope subscription selects skills, MCPs, and hooks", () => {
  const snapshot: AssetCatalog = {
    assets: [asset(a), asset(b, "mcp"), asset(c, "hook")],
    distributions: [
      {
        scope: org,
        assets: [a, b, c].map((assetId) => ({ assetId, mode: "recommended" })),
      },
    ],
  };

  expect(
    resolveAssets(
      snapshot,
      state({ subscriptions: [subscription(org)] }),
    ).assets.map((entry) => entry.asset.kind),
  ).toStrictEqual(["skill", "mcp", "hook"]);
});

test("scope install adds, changes mode in place, and enables a previously disabled subscription", () => {
  let input = apply(state(), {
    type: "install-scope",
    scope: org,
    mode: "recommended",
  });

  input = apply(input, {
    type: "install-scope",
    scope: frontend,
    mode: "optional",
  });

  input = apply(input, {
    type: "set-scope-enabled",
    scope: org,
    enabled: false,
  });

  input = apply(input, { type: "install-scope", scope: org, mode: "all" });
  expect(input.subscriptions.length).toBe(2);
  expect(
    input.subscriptions.find((entry) => entry.scope.type === "org"),
  ).toStrictEqual(subscription(org));
});

test("team switch replaces all team subscriptions while preserving other selections and preferences", () => {
  const input = state({
    subscriptions: [
      subscription(org),
      subscription(frontend),
      subscription(platform),
      subscription(repo),
    ],
    individualAssetIds: [d],
    excludedAssetIds: [b],
    disabledAssetIds: [c],
  });

  const next = apply(input, {
    type: "switch-team",
    scope: platform,
    mode: "optional",
  });

  expect(
    next.subscriptions.filter((entry) => entry.scope.type === "team"),
  ).toStrictEqual([subscription(platform, "optional")]);

  expect(next.subscriptions.length).toBe(3);
  expect(next.individualAssetIds).toStrictEqual([d]);
  expect(next.excludedAssetIds).toStrictEqual([b]);
  expect(next.disabledAssetIds).toStrictEqual([c]);
  const withoutTeams = apply(next, { type: "remove-scope", scope: platform });
  expect(
    withoutTeams.subscriptions.every((entry) => entry.scope.type !== "team"),
  ).toBeTruthy();
});

test("subscription removal drops only its contribution; independent and other scope sources survive", () => {
  const input = state({
    subscriptions: [subscription(org), subscription(frontend)],
    individualAssetIds: [b],
  });

  expect(
    selected(apply(input, { type: "remove-scope", scope: org })),
  ).toStrictEqual([
    [a, true],
    [b, true],
    [c, true],
  ]);
});

test("enabling does not install an asset, clear exclusions, or activate a disabled subscription", () => {
  const input = state({
    subscriptions: [subscription(org, "all", false)],
    excludedAssetIds: [b],
    disabledAssetIds: [a, b, d],
  });

  let next = input;
  for (const assetId of [a, b, d]) {
    next = apply(next, { type: "set-asset-enabled", assetId, enabled: true });
  }

  expect(selected(next)).toStrictEqual([[a, false]]);
  expect(next.excludedAssetIds).toStrictEqual([b]);
});

test("ordinary set re-enabling preserves exclusions and individual disable overrides without a decision", () => {
  const input = state({
    subscriptions: [subscription(org, "all", false)],
    excludedAssetIds: [b],
    disabledAssetIds: [a],
  });

  const next = apply(input, {
    type: "set-scope-enabled",
    scope: org,
    enabled: true,
  });

  expect(selected(next)).toStrictEqual([[a, false]]);
  expect(next.excludedAssetIds).toStrictEqual([b]);
});

for (const action of [
  { type: "install-scope", scope: org, mode: "all" },
  { type: "switch-team", scope: frontend, mode: "all" },
] as const) {
  test(`${action.type}: conflicts include metadata; absent and incomplete decisions do not apply`, () => {
    const input = state({
      subscriptions: [subscription(platform)],
      excludedAssetIds: [a],
      disabledAssetIds: [a, b, c],
    });

    const before = structuredClone(input);
    const result = applySelectionAction(catalog(), input, action);
    expect(result.status).toBe("decision-required");
    if (result.status !== "decision-required") {
      return;
    }

    expect(result.conflicts.length).toBe(2);
    expect(result.conflicts[0]).toStrictEqual({
      asset: asset(a),
      excluded: true,
      individuallyDisabled: true,
    });

    expect(
      applySelectionAction(catalog(), input, action, {
        type: "per-asset",
        decisions: [{ assetId: a, choice: "clear" }],
      }),
    ).toStrictEqual(result);

    expect(input).toStrictEqual(before);
  });
}

test("preserve-all installs and enables scope while retaining all individual choices", () => {
  const input = state({
    subscriptions: [subscription(org, "recommended", false)],
    excludedAssetIds: [a],
    disabledAssetIds: [b],
  });

  const next = apply(
    input,
    { type: "install-scope", scope: org, mode: "all" },
    { type: "preserve-all" },
  );

  expect(selected(next)).toStrictEqual([[b, false]]);
  expect(next.subscriptions[0]!.enabled).toBe(true);
});

test("clear-all only clears matching overrides, has global UUID effect, and creates no independent selection", () => {
  const input = state({
    subscriptions: [subscription(frontend)],
    excludedAssetIds: [a, b],
    disabledAssetIds: [a, c, d],
  });

  const next = apply(
    input,
    { type: "install-scope", scope: org, mode: "recommended" },
    { type: "clear-all" },
  );

  expect(next.excludedAssetIds).toStrictEqual([b]);
  expect(next.disabledAssetIds).toStrictEqual([c, d]);
  expect(next.individualAssetIds).toStrictEqual([]);
  expect(resolveAssets(catalog(), next).assets[0]!.contributions.length).toBe(
    2,
  );

  expect(selected(next)).toStrictEqual([
    [a, true],
    [c, false],
  ]);
});

test("per-asset decisions mix preserve and clear; unrelated decisions cannot clear other assets", () => {
  const input = state({
    excludedAssetIds: [a, b, d],
    disabledAssetIds: [a, b, d],
  });

  const next = apply(
    input,
    { type: "install-scope", scope: org, mode: "all" },
    {
      type: "per-asset",
      decisions: [
        { assetId: a, choice: "clear" },
        { assetId: b, choice: "preserve" },
        { assetId: d, choice: "clear" },
      ],
    },
  );

  expect(next.excludedAssetIds).toStrictEqual([b, d]);
  expect(next.disabledAssetIds).toStrictEqual([b, d]);
  expect(selected(next)).toStrictEqual([[a, true]]);
});

test("team switch conflict resolution applies atomically and preserves individual team assets", () => {
  const input = state({
    subscriptions: [subscription(platform)],
    individualAssetIds: [b],
    disabledAssetIds: [a],
  });

  const next = apply(
    input,
    { type: "switch-team", scope: frontend, mode: "all" },
    { type: "clear-all" },
  );

  expect(next.subscriptions).toStrictEqual([subscription(frontend)]);
  expect(selected(next)).toStrictEqual([
    [a, true],
    [b, true],
    [c, true],
  ]);
});

test("conflicts are recalculated from the current catalogue and require newly affected decisions", () => {
  const input = state({ disabledAssetIds: [a, c] });
  const action = {
    type: "install-scope",
    scope: org,
    mode: "recommended",
  } as const;

  const snapshot = catalog();
  const changed: AssetCatalog = {
    ...snapshot,
    distributions: [
      {
        scope: org,
        assets: [
          { assetId: a, mode: "recommended" },
          { assetId: c, mode: "recommended" },
        ],
      },
    ],
  };

  const result = applySelectionAction(changed, input, action, {
    type: "per-asset",
    decisions: [{ assetId: a, choice: "clear" }],
  });

  expect(result.status).toBe("decision-required");
  if (result.status === "decision-required") {
    expect(result.conflicts.length).toBe(2);
  }
});

test("sync follows additions, removals, mode changes, renames, origin moves, and published updates", () => {
  const input = state({
    subscriptions: [subscription(org, "recommended")],
    individualAssetIds: [d],
    excludedAssetIds: [c],
    disabledAssetIds: [a],
  });

  const snapshot = catalog();
  const changed: AssetCatalog = {
    assets: snapshot.assets.map((entry) => ({
      ...entry,
      name: "renamed",
      publishedVersion: "v2",
      origin: platform,
    })),
    distributions: [
      {
        scope: org,
        assets: [
          { assetId: a, mode: "recommended" },
          { assetId: b, mode: "recommended" },
          { assetId: c, mode: "recommended" },
        ],
      },
    ],
  };

  const result = resolveAssets(changed, input);
  expect(selected(input, changed)).toStrictEqual([
    [a, false],
    [b, true],
    [d, true],
  ]);

  expect(
    result.assets.every(
      (entry) =>
        entry.asset.name === "renamed" &&
        entry.asset.publishedVersion === "v2" &&
        entry.asset.origin.id === platform.id,
    ),
  ).toBeTruthy();

  expect(
    selected(input, {
      ...changed,
      distributions: [{ scope: org, assets: [] }],
    }),
  ).toStrictEqual([[d, true]]);

  expect(selected(input)).toStrictEqual([
    [a, false],
    [d, true],
  ]);
});

test("disabled sets follow catalogue changes without activating new matches", () => {
  const input = state({ subscriptions: [subscription(org, "all", false)] });
  const snapshot = catalog();
  const changed: AssetCatalog = {
    ...snapshot,
    distributions: [{ scope: org, assets: [{ assetId: c, mode: "optional" }] }],
  };

  expect(selected(input, changed)).toStrictEqual([[c, false]]);
});

test("missing references report diagnostics, leave choices intact, and recover on later snapshots", () => {
  const input = state({
    subscriptions: [subscription(org), subscription(repo)],
    individualAssetIds: [d],
  });

  const before = structuredClone(input);
  const result = resolveAssets(
    {
      assets: [],
      distributions: [
        { scope: org, assets: [{ assetId: a, mode: "recommended" }] },
      ],
    },
    input,
  );

  expect(result).toStrictEqual({
    assets: [],
    diagnostics: [
      { type: "missing-scope", scope: repo },
      { type: "missing-asset", assetId: a },
      { type: "missing-asset", assetId: d },
    ],
  });

  expect(input).toStrictEqual(before);
  expect(resolveAssets(catalog(), input).assets.length).toBe(4);
});

test("UUID identity is case insensitive across catalogue, state, and explicit actions", () => {
  const upperId = uuid(0xab).toUpperCase();
  const snapshot: AssetCatalog = {
    assets: [asset(upperId)],
    distributions: [],
  };

  const next = apply(
    state(),
    { type: "install-asset", assetId: upperId.toLowerCase() },
    undefined,
    snapshot,
  );

  expect(resolveAssets(snapshot, next).assets[0]!.asset.id).toBe(
    upperId.toLowerCase(),
  );
});

test("contradictory identities, distribution modes, and duplicate subscriptions fail explicitly", () => {
  const snapshot = catalog();
  expect(() =>
    resolveAssets(
      {
        ...snapshot,
        assets: [...snapshot.assets, { ...asset(a), name: "different" }],
      },
      state(),
    ),
  ).toThrow(/Duplicate catalogue asset ID/);

  expect(() =>
    resolveAssets(
      {
        ...snapshot,
        distributions: [...snapshot.distributions, snapshot.distributions[0]!],
      },
      state(),
    ),
  ).toThrow(/Duplicate distribution scope/);

  expect(() =>
    resolveAssets(
      {
        ...snapshot,
        distributions: [
          {
            scope: org,
            assets: [
              { assetId: a, mode: "recommended" },
              { assetId: a, mode: "optional" },
            ],
          },
        ],
      },
      state(),
    ),
  ).toThrow(/Conflicting recommendation modes/);

  expect(() =>
    resolveAssets(
      snapshot,
      state({
        subscriptions: [subscription(org), subscription(org, "optional")],
      }),
    ),
  ).toThrow(/Only one subscription/);

  expect(() =>
    resolveAssets(snapshot, state({ individualAssetIds: ["not-a-uuid"] })),
  ).toThrow(/Expected UUIDv4/);
});

test("invalid explicit operations fail without modifying input", () => {
  const input = state({ excludedAssetIds: [a] });
  expect(() =>
    apply(input, { type: "install-asset", assetId: uuid(999) }),
  ).toThrow(/Unknown asset/);

  expect(() =>
    apply(input, {
      type: "install-scope",
      scope: { type: "team", id: uuid(999) },
      mode: "all",
    }),
  ).toThrow(/Unknown scope/);

  expect(() =>
    apply(input, { type: "set-scope-enabled", scope: org, enabled: true }),
  ).toThrow(/not selected/);

  expect(() =>
    apply(
      input,
      { type: "install-scope", scope: org, mode: "all" },
      {
        type: "per-asset",
        decisions: [
          { assetId: a, choice: "clear" },
          { assetId: a, choice: "preserve" },
        ],
      },
    ),
  ).toThrow(/Duplicate override decision/);

  expect(input).toStrictEqual(state({ excludedAssetIds: [a] }));
});

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      freeze(child);
    }
  }

  return value;
}

test("recommendation changes move subscriptions in both directions without changing individual choices", () => {
  const input = state({
    subscriptions: [
      subscription(org, "recommended"),
      subscription(frontend, "optional"),
    ],
    individualAssetIds: [a],
    disabledAssetIds: [c],
  });

  const snapshot: AssetCatalog = {
    ...catalog(),
    distributions: [
      {
        scope: org,
        assets: [
          { assetId: a, mode: "optional" },
          { assetId: b, mode: "recommended" },
        ],
      },
      { scope: frontend, assets: [{ assetId: c, mode: "recommended" }] },
    ],
  };

  const result = resolveAssets(snapshot, input);
  expect(result.assets.map((entry) => entry.asset.id)).toStrictEqual([a, b]);
  expect(result.assets[0]!.contributions).toStrictEqual([
    { type: "individual" },
  ]);

  expect(input.disabledAssetIds).toStrictEqual([c]);
});

test("identical distribution entries install once and missing asset diagnostics deduplicate across sources", () => {
  const snapshot: AssetCatalog = {
    assets: [asset(a)],
    distributions: [
      {
        scope: org,
        assets: [
          { assetId: a, mode: "recommended" },
          { assetId: a, mode: "recommended" },
          { assetId: b, mode: "optional" },
        ],
      },
      { scope: frontend, assets: [{ assetId: b, mode: "recommended" }] },
    ],
  };

  const result = resolveAssets(
    snapshot,
    state({
      subscriptions: [subscription(org), subscription(frontend)],
      individualAssetIds: [b],
    }),
  );

  expect(result.assets.length).toBe(1);
  expect(result.assets[0]!.contributions.length).toBe(1);
  expect(result.diagnostics).toStrictEqual([
    { type: "missing-asset", assetId: b },
  ]);
});

test("missing metadata cannot silently clear an override during scope installation", () => {
  const snapshot: AssetCatalog = {
    assets: [],
    distributions: [
      { scope: org, assets: [{ assetId: a, mode: "recommended" }] },
    ],
  };

  expect(() =>
    applySelectionAction(
      snapshot,
      state({ excludedAssetIds: [a] }),
      { type: "install-scope", scope: org, mode: "all" },
      { type: "clear-all" },
    ),
  ).toThrow(/missing asset/);
});

for (const action of [
  { type: "install-scope", scope: org, mode: "all" },
  { type: "switch-team", scope: frontend, mode: "all" },
  { type: "remove-scope", scope: org },
  { type: "set-scope-enabled", scope: org, enabled: false },
  { type: "set-scope-enabled", scope: org, enabled: true },
  { type: "install-asset", assetId: a },
  { type: "remove-asset", assetId: a },
  { type: "set-asset-enabled", assetId: a, enabled: true },
  { type: "set-asset-enabled", assetId: a, enabled: false },
] as const) {
  test(`repeating ${action.type}${"enabled" in action ? ` (${action.enabled})` : ""} is stable`, () => {
    const input = state({
      subscriptions: [subscription(org), subscription(platform)],
      disabledAssetIds: [a],
      excludedAssetIds: [b],
    });

    const next = apply(input, action, { type: "preserve-all" });
    expect(apply(next, action, { type: "preserve-all" })).toStrictEqual(next);
  });
}

test("frozen inputs are supported; results and actions are deterministic and workspace isolated", () => {
  const snapshot = freeze(catalog());
  const first = freeze(state({ subscriptions: [subscription(org)] }));
  const second = freeze(state({ individualAssetIds: [d] }));
  const result = resolveAssets(snapshot, first);
  expect(resolveAssets(snapshot, first)).toStrictEqual(result);
  const action = freeze({ type: "remove-asset", assetId: a } as const);
  const next = apply(first, action, undefined, snapshot);
  expect(apply(next, action, undefined, snapshot)).toStrictEqual(next);
  expect(
    resolveAssets(snapshot, second).assets.map((entry) => entry.asset.id),
  ).toStrictEqual([d]);

  expect(resolveAssets(snapshot, first)).toStrictEqual(result);
  expect(JSON.parse(JSON.stringify(next))).toStrictEqual(next);
});

test("catalogue and selection permutations produce identical results and action states", () => {
  const snapshot = catalog();
  const reversed: AssetCatalog = {
    assets: [...snapshot.assets].reverse(),
    distributions: [...snapshot.distributions]
      .reverse()
      .map((entry) => ({ ...entry, assets: [...entry.assets].reverse() })),
  };

  const input = state({
    subscriptions: [
      subscription(org),
      subscription(platform),
      subscription(frontend),
    ],
    individualAssetIds: [d, a, a],
    disabledAssetIds: [c, a],
  });

  const shuffled: SelectionState = {
    ...input,
    subscriptions: [...input.subscriptions].reverse(),
    individualAssetIds: [a, d],
    disabledAssetIds: [a, c],
  };

  expect(resolveAssets(snapshot, input)).toStrictEqual(
    resolveAssets(reversed, shuffled),
  );

  const action = { type: "install-scope", scope: org, mode: "all" } as const;
  expect(applySelectionAction(snapshot, input, action)).toStrictEqual(
    applySelectionAction(reversed, shuffled, action),
  );

  expect(apply(input, action, { type: "preserve-all" })).toStrictEqual(
    apply(shuffled, action, { type: "preserve-all" }, reversed),
  );
});
