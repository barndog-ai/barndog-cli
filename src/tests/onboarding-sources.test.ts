import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  onboardingSources,
  selectOnboardingSources,
  type EnvironmentChoices,
} from "../features/onboarding/environment.js";

function fixture(): EnvironmentChoices {
  const org = randomUUID(),
    team = randomUUID(),
    other = randomUUID(),
    developerId = randomUUID();
  const origin = { type: "org" as const, id: org, slug: "acme" };
  const assets = ["recommended", "optional"].map((name) => ({
    id: randomUUID(),
    kind: "skill" as const,
    name,
    origin,
    publishedVersion: randomUUID(),
  }));
  const own = {
    id: randomUUID(),
    kind: "mcp" as const,
    name: "mine",
    origin: { type: "dev" as const, id: developerId, slug: "alice" },
    publishedVersion: randomUUID(),
  };
  return {
    scopes: [
      { type: "org", id: org, slug: "acme", name: "Acme", canPublish: false },
      {
        type: "team",
        id: team,
        slug: "engineering",
        name: "Engineering",
        canPublish: false,
      },
      {
        type: "team",
        id: other,
        slug: "other",
        name: "Other",
        canPublish: true,
      },
      ...Array.from({ length: 100 }, (_, i) => ({
        type: "repo" as const,
        id: randomUUID(),
        slug: `repo-${i}`,
        name: `Repo ${i}`,
        canPublish: false,
      })),
    ],
    catalog: {
      assets: [...assets, own],
      distributions: [
        {
          scope: { type: "org", id: org },
          assets: [
            { assetId: assets[0]!.id, mode: "recommended" },
            { assetId: assets[1]!.id, mode: "optional" },
            { assetId: own.id, mode: "recommended" },
          ],
        },
      ],
    },
    developerId,
    memberTeamIds: [team],
    firstSetup: true,
    previous: {
      subscriptions: [],
      individualAssetIds: [],
      excludedAssetIds: [],
      disabledAssetIds: [],
    },
  };
}

test("setup defaults organization and sole membership team, regardless of other visible teams and repositories", () => {
  const choices = fixture();
  const sources = onboardingSources(choices);
  assert.deepEqual(
    sources.map((s) => s.scope.type),
    ["org", "team", "dev"],
  );
  assert.deepEqual(
    sources.map((s) => s.checked),
    [true, true, false],
  );
  choices.memberTeamIds = choices.scopes
    .filter((s) => s.type === "team")
    .map((s) => s.id);
  assert.deepEqual(
    onboardingSources(choices)
      .filter((s) => s.scope.type === "team")
      .map((s) => s.checked),
    [false, false],
  );
  choices.firstSetup = false;
  assert.ok(onboardingSources(choices).every((s) => !s.checked));
});

test("setup replaces the environment with exactly the chosen sources", () => {
  const choices = fixture();
  const org = choices.scopes[0]!;
  const repo = choices.scopes.find((s) => s.type === "repo")!;
  const outside = randomUUID();
  choices.previous = {
    subscriptions: [
      { scope: { type: "org", id: org.id }, mode: "all", enabled: false },
      { scope: { type: "repo", id: repo.id }, mode: "all", enabled: true },
    ],
    individualAssetIds: [outside],
    excludedAssetIds: [choices.catalog.assets[0]!.id],
    disabledAssetIds: [choices.catalog.assets[1]!.id],
  };
  const sources = onboardingSources(choices);
  // A subscribed repository is offered so leaving it unchecked removes it.
  assert.ok(sources.some((s) => s.scope.type === "repo" && s.checked));
  const selected = selectOnboardingSources([
    {
      source: sources[0]!,
      mode: "custom",
      assetIds: [choices.catalog.assets[1]!.id],
    },
  ]);
  assert.deepEqual(selected, {
    subscriptions: [],
    individualAssetIds: [choices.catalog.assets[1]!.id],
    excludedAssetIds: [],
    disabledAssetIds: [],
  });
  assert.throws(
    () =>
      selectOnboardingSources([
        { source: sources[0]!, mode: "custom", assetIds: [outside] },
      ]),
    /outside this source/,
  );
});

test("own assets offer all, recommended, and custom without including other developers", () => {
  const choices = fixture();
  const own = choices.catalog.assets[2]!;
  choices.catalog.assets.push({
    ...own,
    id: randomUUID(),
    origin: { type: "dev", id: randomUUID(), slug: "bob" },
  });
  const sources = onboardingSources(choices);
  const personal = sources.find((s) => s.scope.type === "dev")!;
  assert.deepEqual(
    personal.assets.map((a) => a.id),
    [own.id],
  );
  assert.deepEqual(personal.recommendedIds, [own.id]);
  for (const mode of ["all", "recommended", "custom"] as const) {
    const state = selectOnboardingSources([
      { source: personal, mode, assetIds: [own.id] },
    ]);
    assert.deepEqual(state.individualAssetIds, [own.id]);
    assert.deepEqual(state.subscriptions, []);
  }
});

test("legacy optional selections reopen as custom and a re-chosen subscription is enabled", () => {
  const choices = fixture();
  choices.previous = {
    ...choices.previous,
    subscriptions: [
      {
        scope: { type: "org", id: choices.scopes[0]!.id },
        mode: "optional",
        enabled: false,
      },
    ],
  };
  const sources = onboardingSources(choices);
  assert.equal(sources[0]!.mode, "custom");
  assert.deepEqual(sources[0]!.selectedIds, [choices.catalog.assets[1]!.id]);
  const next = selectOnboardingSources([{ source: sources[0]!, mode: "all" }]);
  assert.equal(next.subscriptions[0]!.enabled, true);
});

test("reopening a subscribed source keeps its subscription and drops earlier individual picks", () => {
  const choices = fixture();
  const scope = { type: "org" as const, id: choices.scopes[0]!.id };
  const individual = choices.catalog.assets[1]!.id;
  choices.previous = {
    ...choices.previous,
    subscriptions: [{ scope, mode: "recommended", enabled: true }],
    individualAssetIds: [individual],
  };
  choices.firstSetup = false;
  const sources = onboardingSources(choices);
  assert.equal(sources[0]!.mode, "recommended");
  const next = selectOnboardingSources([
    { source: sources[0]!, mode: sources[0]!.mode },
  ]);
  assert.deepEqual(next.subscriptions, choices.previous.subscriptions);
  assert.deepEqual(next.individualAssetIds, []);
});
