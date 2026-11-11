# Asset selection engine

Pure, synchronous selection logic for skills, MCP configurations, and hooks. The
public entry point is `index.ts`. It has no runtime dependencies, I/O, or harness
knowledge. The CLI persists this model in user-level settings and resolves it before synchronization.

## Inputs and results

`AssetCatalog` is a complete, access-filtered snapshot for one organization:

- `assets` contains current published identity metadata. Content remains in the
  separate skill, MCP, and hook models. Origin and published version are metadata,
  not identity.
- `distributions` contains the selectable organization, team, and repository
  scopes. Each entry assigns asset IDs to `recommended` or `optional`. An empty
  scope has an empty list; an unavailable scope is absent. Multiple scopes may
  reference the same asset ID. Distribution membership is separate from ownership.

`SelectionState` belongs to the selected user-level environment. Its subscriptions have a scope, one mode
(`recommended`, `optional`, or `all`), and an enabled flag. Independent selections,
exclusions, and individual disable overrides are UUID lists. Callers own persistence,
organization boundaries and access checks. No selection is
inferred from membership, repository ownership, or recommendations.

All entity IDs must be UUIDv4. IDs are normalized to lowercase. Duplicate catalogue
asset IDs, duplicate scope distributions/subscriptions, conflicting recommendation
modes within one scope, and duplicate per-asset decisions throw errors. Repeated
identical distribution entries and repeated IDs in state lists are deduplicated.
Inputs are typed domain data; this module is not a schema validator for untrusted
JSON or YAML.

`resolveAssets(catalog, state)` returns:

- `assets`: desired local installations, sorted by UUID. Each entry contains
  metadata, `enabled`, `individuallyDisabled`, and every contributing source.
  Subscription sources are ordered by scope type/UUID, followed by an independent
  source if selected. Names are not deduplication keys.
- `diagnostics`: missing subscribed scopes, then missing selected asset IDs, each
  group sorted by identity. Missing references contribute no installations and do
  not erase saved choices. A later complete snapshot can supply them again.

An installed-but-disabled asset remains in `assets` with `enabled: false`. Harness
delivery will use only enabled assets after compatibility and conflict resolution.
This result does not describe files already on disk. Callers must obtain a complete
snapshot before using it to reconcile installation; a failed or partial fetch is
not an authoritative empty catalogue. Diagnostics must be handled by that caller.

## Overlapping teams and local activation

The examples below use valid UUIDv4 values for teams and assets. Assume `catalog`
has both teams distributing the same `assetId`.

```ts
import {
  applySelectionAction,
  resolveAssets,
  type SelectionState,
} from "./index.js";

const frontend = {
  type: "team",
  id: "00000000-0000-4000-8000-000000000101",
} as const;
const platform = {
  type: "team",
  id: "00000000-0000-4000-8000-000000000102",
} as const;
const assetId = "00000000-0000-4000-8000-000000000001";
const state: SelectionState = {
  subscriptions: [
    { scope: frontend, mode: "recommended", enabled: false },
    { scope: platform, mode: "all", enabled: true },
  ],
  individualAssetIds: [],
  excludedAssetIds: [],
  disabledAssetIds: [],
};

const effective = resolveAssets(catalog, state);
// One installation for assetId, enabled by platform, with both contributions.
const disabled = applySelectionAction(catalog, state, {
  type: "set-asset-enabled",
  assetId,
  enabled: false,
});
// If applied, resolving disabled.state keeps the installation but disables it
// regardless of either team's activation.
```

Disabling a subscription retains its membership and keeps following matching
catalogue changes. It supplies installation but no activation. An enabled source
activates an asset unless an individual disable override exists. Enabling an
individual asset clears that override only: it does not select an asset, remove an
exclusion, or enable a disabled set.

## Actions and exclusions

`applySelectionAction(catalog, state, action, resolution?)` returns either
`{ status: "applied", state }` or `{ status: "decision-required", conflicts }`.
It never mutates inputs or partially applies a pending decision.

Supported actions:

| Action              | Effect                                                                       |
| ------------------- | ---------------------------------------------------------------------------- |
| `install-scope`     | Add/replace that scope's mode and enable its subscription.                   |
| `switch-team`       | Replace every team subscription with the chosen team/mode, enabled.          |
| `remove-scope`      | Remove only that subscription's contribution.                                |
| `set-scope-enabled` | Change activation of an existing subscription.                               |
| `install-asset`     | Independently select the asset and clear its exclusion and disable override. |
| `remove-asset`      | Remove its independent selection and record a workspace exclusion.           |
| `set-asset-enabled` | Add or clear an individual disable override.                                 |

Removing an unselected scope or repeating asset removal is harmless. Installing an
unknown asset/scope or changing activation of an unselected scope throws. Removal
and individual activation operations accept IDs absent from the catalogue so stale
local preferences can still be managed. Dormant exclusions and disable overrides
persist until explicitly cleared, including across scope removal and later re-addition.

```ts
const removed = applySelectionAction(catalog, state, {
  type: "remove-asset",
  assetId,
});
if (removed.status === "applied") {
  // Scope subscriptions cannot reinstall this UUID on subsequent resolutions.
  const reinstalled = applySelectionAction(catalog, removed.state, {
    type: "install-asset",
    assetId,
  });
  // Reinstall selects it independently, clears both overrides, and enables it.
}
```

## Scope installation decisions

Scope installs (including reinstall and mode changes) and team switching inspect
only matching assets in the incoming scope/mode. Existing exclusions or individual
disable overrides require a decision. Conflict records contain current asset
metadata and both override flags. Switching teams preserves organization,
repository, individual selections, and local overrides unless a resolution
explicitly clears an affected override.

```ts
const action = { type: "install-scope", scope: frontend, mode: "all" } as const;
const pending = applySelectionAction(catalog, state, action);
if (pending.status === "decision-required") {
  // A future CLI can display pending.conflicts and collect these choices.
  const applied = applySelectionAction(catalog, state, action, {
    type: "per-asset",
    decisions: pending.conflicts.map(({ asset }) => ({
      assetId: asset.id,
      choice: asset.id === assetId ? "clear" : "preserve",
    })),
  });
}
```

Use `{ type: "preserve-all" }` or `{ type: "clear-all" }` for bulk choices. Per-asset
resolution requires a choice for every current conflict. Missing choices return
`decision-required` again; unrelated choices never clear unrelated overrides.
Conflicts are recomputed against current inputs each call. A conflicting reference
missing its catalogue metadata throws rather than silently clearing that override.

Clearing removes both override flags for the affected UUID across the workspace;
it does not create an independent selection. Unmatched assets retain their choices.
Routine resolution and re-enabling saved subscriptions preserve overrides without
requiring decisions. UI prompts, harness naming conflicts/aliases, compatibility,
policy inheritance, and installation are outside this module.
