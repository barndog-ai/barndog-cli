import { test } from "node:test";
import assert from "node:assert/strict";
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
  assert.equal(result.status, "applied");
  if (result.status !== "applied") throw new Error("Expected action to apply");
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
      assert.deepEqual(
        result.assets.map((entry) => entry.asset.id),
        expected,
      );
      assert.ok(
        result.assets.every(
          (entry) => entry.enabled && entry.asset.kind === kind,
        ),
      );
    });
  }
  test(`${kind}: empty state never installs recommendations or owning-team assets`, () => {
    assert.deepEqual(resolveAssets(catalog(kind), state()), {
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
    assert.deepEqual(
      result.assets.map((entry) => entry.asset.id),
      [a, c, d],
    );
    assert.equal(result.assets[0]!.contributions.length, 3);
    assert.equal(result.assets[0]!.asset.name, result.assets[1]!.asset.name);
    assert.equal(result.assets[2]!.asset.origin.type, "dev");
  });
  test(`${kind}: disabled subscriptions keep installation intent and another source can enable`, () => {
    const input = state({
      subscriptions: [subscription(org, "all", false), subscription(platform)],
    });
    assert.deepEqual(selected(input, catalog(kind)), [
      [a, true],
      [b, false],
    ]);
    assert.deepEqual(
      selected({ ...input, individualAssetIds: [b] }, catalog(kind)),
      [
        [a, true],
        [b, true],
      ],
    );
  });
  test(`${kind}: individual disable wins over all sources and enabling clears only that override`, () => {
    const input = state({
      subscriptions: [subscription(org)],
      individualAssetIds: [a],
      disabledAssetIds: [a],
    });
    assert.deepEqual(selected(input, catalog(kind)), [
      [a, false],
      [b, true],
    ]);
    const enabled = apply(
      input,
      { type: "set-asset-enabled", assetId: a, enabled: true },
      undefined,
      catalog(kind),
    );
    assert.deepEqual(selected(enabled, catalog(kind)), [
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
    assert.deepEqual(removed.individualAssetIds, []);
    assert.deepEqual(selected(removed, catalog(kind)), [
      [b, true],
      [c, true],
    ]);
    const installed = apply(
      removed,
      { type: "install-asset", assetId: a },
      undefined,
      catalog(kind),
    );
    assert.deepEqual(installed.excludedAssetIds, []);
    assert.deepEqual(installed.disabledAssetIds, []);
    assert.equal(selected(installed, catalog(kind))[0]![1], true);
    assert.deepEqual(installed.individualAssetIds, [a]);
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
  assert.deepEqual(
    resolveAssets(
      snapshot,
      state({ subscriptions: [subscription(org)] }),
    ).assets.map((entry) => entry.asset.kind),
    ["skill", "mcp", "hook"],
  );
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
  assert.equal(input.subscriptions.length, 2);
  assert.deepEqual(
    input.subscriptions.find((entry) => entry.scope.type === "org"),
    subscription(org),
  );
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
  assert.deepEqual(
    next.subscriptions.filter((entry) => entry.scope.type === "team"),
    [subscription(platform, "optional")],
  );
  assert.equal(next.subscriptions.length, 3);
  assert.deepEqual(next.individualAssetIds, [d]);
  assert.deepEqual(next.excludedAssetIds, [b]);
  assert.deepEqual(next.disabledAssetIds, [c]);
  const withoutTeams = apply(next, { type: "remove-scope", scope: platform });
  assert.ok(
    withoutTeams.subscriptions.every((entry) => entry.scope.type !== "team"),
  );
});

test("subscription removal drops only its contribution; independent and other scope sources survive", () => {
  const input = state({
    subscriptions: [subscription(org), subscription(frontend)],
    individualAssetIds: [b],
  });
  assert.deepEqual(
    selected(apply(input, { type: "remove-scope", scope: org })),
    [
      [a, true],
      [b, true],
      [c, true],
    ],
  );
});

test("enabling does not install an asset, clear exclusions, or activate a disabled subscription", () => {
  const input = state({
    subscriptions: [subscription(org, "all", false)],
    excludedAssetIds: [b],
    disabledAssetIds: [a, b, d],
  });
  let next = input;
  for (const assetId of [a, b, d])
    next = apply(next, { type: "set-asset-enabled", assetId, enabled: true });
  assert.deepEqual(selected(next), [[a, false]]);
  assert.deepEqual(next.excludedAssetIds, [b]);
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
  assert.deepEqual(selected(next), [[a, false]]);
  assert.deepEqual(next.excludedAssetIds, [b]);
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
    assert.equal(result.status, "decision-required");
    if (result.status !== "decision-required") return;
    assert.equal(result.conflicts.length, 2);
    assert.deepEqual(result.conflicts[0], {
      asset: asset(a),
      excluded: true,
      individuallyDisabled: true,
    });
    assert.deepEqual(
      applySelectionAction(catalog(), input, action, {
        type: "per-asset",
        decisions: [{ assetId: a, choice: "clear" }],
      }),
      result,
    );
    assert.deepEqual(input, before);
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
  assert.deepEqual(selected(next), [[b, false]]);
  assert.equal(next.subscriptions[0]!.enabled, true);
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
  assert.deepEqual(next.excludedAssetIds, [b]);
  assert.deepEqual(next.disabledAssetIds, [c, d]);
  assert.deepEqual(next.individualAssetIds, []);
  assert.equal(
    resolveAssets(catalog(), next).assets[0]!.contributions.length,
    2,
  );
  assert.deepEqual(selected(next), [
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
  assert.deepEqual(next.excludedAssetIds, [b, d]);
  assert.deepEqual(next.disabledAssetIds, [b, d]);
  assert.deepEqual(selected(next), [[a, true]]);
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
  assert.deepEqual(next.subscriptions, [subscription(frontend)]);
  assert.deepEqual(selected(next), [
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
  assert.equal(result.status, "decision-required");
  if (result.status === "decision-required")
    assert.equal(result.conflicts.length, 2);
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
  assert.deepEqual(selected(input, changed), [
    [a, false],
    [b, true],
    [d, true],
  ]);
  assert.ok(
    result.assets.every(
      (entry) =>
        entry.asset.name === "renamed" &&
        entry.asset.publishedVersion === "v2" &&
        entry.asset.origin.id === platform.id,
    ),
  );
  assert.deepEqual(
    selected(input, {
      ...changed,
      distributions: [{ scope: org, assets: [] }],
    }),
    [[d, true]],
  );
  assert.deepEqual(selected(input), [
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
  assert.deepEqual(selected(input, changed), [[c, false]]);
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
  assert.deepEqual(result, {
    assets: [],
    diagnostics: [
      { type: "missing-scope", scope: repo },
      { type: "missing-asset", assetId: a },
      { type: "missing-asset", assetId: d },
    ],
  });
  assert.deepEqual(input, before);
  assert.equal(resolveAssets(catalog(), input).assets.length, 4);
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
  assert.equal(
    resolveAssets(snapshot, next).assets[0]!.asset.id,
    upperId.toLowerCase(),
  );
});

test("contradictory identities, distribution modes, and duplicate subscriptions fail explicitly", () => {
  const snapshot = catalog();
  assert.throws(
    () =>
      resolveAssets(
        {
          ...snapshot,
          assets: [...snapshot.assets, { ...asset(a), name: "different" }],
        },
        state(),
      ),
    /Duplicate catalogue asset ID/,
  );
  assert.throws(
    () =>
      resolveAssets(
        {
          ...snapshot,
          distributions: [
            ...snapshot.distributions,
            snapshot.distributions[0]!,
          ],
        },
        state(),
      ),
    /Duplicate distribution scope/,
  );
  assert.throws(
    () =>
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
    /Conflicting recommendation modes/,
  );
  assert.throws(
    () =>
      resolveAssets(
        snapshot,
        state({
          subscriptions: [subscription(org), subscription(org, "optional")],
        }),
      ),
    /Only one subscription/,
  );
  assert.throws(
    () =>
      resolveAssets(snapshot, state({ individualAssetIds: ["not-a-uuid"] })),
    /Expected UUIDv4/,
  );
});

test("invalid explicit operations fail without modifying input", () => {
  const input = state({ excludedAssetIds: [a] });
  assert.throws(
    () => apply(input, { type: "install-asset", assetId: uuid(999) }),
    /Unknown asset/,
  );
  assert.throws(
    () =>
      apply(input, {
        type: "install-scope",
        scope: { type: "team", id: uuid(999) },
        mode: "all",
      }),
    /Unknown scope/,
  );
  assert.throws(
    () =>
      apply(input, { type: "set-scope-enabled", scope: org, enabled: true }),
    /not selected/,
  );
  assert.throws(
    () =>
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
    /Duplicate override decision/,
  );
  assert.deepEqual(input, state({ excludedAssetIds: [a] }));
});

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
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
  assert.deepEqual(
    result.assets.map((entry) => entry.asset.id),
    [a, b],
  );
  assert.deepEqual(result.assets[0]!.contributions, [{ type: "individual" }]);
  assert.deepEqual(input.disabledAssetIds, [c]);
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
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0]!.contributions.length, 1);
  assert.deepEqual(result.diagnostics, [{ type: "missing-asset", assetId: b }]);
});

test("missing metadata cannot silently clear an override during scope installation", () => {
  const snapshot: AssetCatalog = {
    assets: [],
    distributions: [
      { scope: org, assets: [{ assetId: a, mode: "recommended" }] },
    ],
  };
  assert.throws(
    () =>
      applySelectionAction(
        snapshot,
        state({ excludedAssetIds: [a] }),
        { type: "install-scope", scope: org, mode: "all" },
        { type: "clear-all" },
      ),
    /missing asset/,
  );
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
    assert.deepEqual(apply(next, action, { type: "preserve-all" }), next);
  });
}

test("frozen inputs are supported; results and actions are deterministic and workspace isolated", () => {
  const snapshot = freeze(catalog());
  const first = freeze(state({ subscriptions: [subscription(org)] }));
  const second = freeze(state({ individualAssetIds: [d] }));
  const result = resolveAssets(snapshot, first);
  assert.deepEqual(resolveAssets(snapshot, first), result);
  const action = freeze({ type: "remove-asset", assetId: a } as const);
  const next = apply(first, action, undefined, snapshot);
  assert.deepEqual(apply(next, action, undefined, snapshot), next);
  assert.deepEqual(
    resolveAssets(snapshot, second).assets.map((entry) => entry.asset.id),
    [d],
  );
  assert.deepEqual(resolveAssets(snapshot, first), result);
  assert.deepEqual(JSON.parse(JSON.stringify(next)), next);
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
  assert.deepEqual(
    resolveAssets(snapshot, input),
    resolveAssets(reversed, shuffled),
  );
  const action = { type: "install-scope", scope: org, mode: "all" } as const;
  assert.deepEqual(
    applySelectionAction(snapshot, input, action),
    applySelectionAction(reversed, shuffled, action),
  );
  assert.deepEqual(
    apply(input, action, { type: "preserve-all" }),
    apply(shuffled, action, { type: "preserve-all" }, reversed),
  );
});
