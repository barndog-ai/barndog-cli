import { beforeEach, expect, test, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { randomUUID } from "node:crypto";
import checkbox from "@inquirer/checkbox";
import select from "@inquirer/select";
import type { EnvironmentChoices } from "../features/onboarding/environment.js";
import { environmentChooser } from "../ui/environment-onboarding.js";

vi.mock("@inquirer/checkbox", () => ({ default: vi.fn() }));
vi.mock("@inquirer/select", () => ({ default: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

function fixture(): EnvironmentChoices {
  const org = randomUUID();
  const team = randomUUID();
  const other = randomUUID();
  const developerId = randomUUID();

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

test.each(["all", "recommended", "custom"])(
  "cloud chooser saves %s selections",
  async (mode) => {
    const choices = fixture();
    vi.mocked(checkbox).mockImplementation(async (options) =>
      options.choices.map((c) => (c as { value: unknown }).value),
    );

    vi.mocked(select).mockResolvedValue(mode);
    const write = vi.fn();
    const result = await environmentChooser(write)(choices);
    expect(write.mock.calls.flat().join("\n")).toContain(
      "Your team is preselected",
    );

    expect(result).toEqual({
      subscriptions:
        mode === "custom"
          ? []
          : choices.scopes.slice(0, 2).map((scope) => ({
              scope: { type: scope.type, id: scope.id },
              mode,
              enabled: true,
            })),
      individualAssetIds:
        mode === "custom"
          ? choices.catalog.assets.map((asset) => asset.id)
          : [choices.catalog.assets[2]!.id],
      excludedAssetIds: [],
      disabledAssetIds: [],
    });
  },
);

function emptyCloudWorkspace() {
  const choices = fixture();
  choices.catalog.assets = [];
  choices.catalog.distributions = [];
  choices.memberTeamIds = choices.scopes
    .filter((s) => s.type === "team")
    .map((s) => s.id);

  vi.mocked(checkbox).mockImplementation(async (options) =>
    options.choices.map((c) => (c as { value: unknown }).value),
  );

  return choices;
}

test("empty cloud workspace with recommended mode subscribes to the org and teams and explains the missing personal assets", async () => {
  const choices = emptyCloudWorkspace();
  vi.mocked(select).mockResolvedValue("recommended");
  const write = vi.fn();
  const result = await environmentChooser(write)(choices);
  const output = write.mock.calls.flat().join("\n");

  expect(output).toContain(
    "You belong to several teams; choose the ones you work with.",
  );

  expect(output).toContain(
    "None of your personal assets are marked recommended in an organization or team set.",
  );

  expect(result).toEqual({
    subscriptions: choices.scopes.slice(0, 3).map((scope) => ({
      scope: { type: scope.type, id: scope.id },
      mode: "recommended",
      enabled: true,
    })),
    individualAssetIds: [],
    excludedAssetIds: [],
    disabledAssetIds: [],
  });
});

test("empty cloud workspace with custom mode says nothing is published and selects nothing", async () => {
  const choices = emptyCloudWorkspace();
  vi.mocked(select).mockResolvedValue("custom");
  const write = vi.fn();
  const result = await environmentChooser(write)(choices);
  const output = write.mock.calls.flat().join("\n");

  expect(output).toContain(
    "No published assets are available yet. Add assets in the web workspace when you're ready.",
  );

  expect(result).toEqual({
    subscriptions: [],
    individualAssetIds: [],
    excludedAssetIds: [],
    disabledAssetIds: [],
  });
});

test("empty git workspace keeps checked subscriptions without prompting", async () => {
  const choices = fixture();
  choices.developerId = null;
  choices.catalog.assets = [];
  const write = vi.fn();
  const result = await environmentChooser(write)(choices);
  expect(result.subscriptions.length).toBeGreaterThan(0);
  expect(checkbox).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
  expect(write.mock.calls.flat().join(" ")).toContain("repo has no assets");
});

test("single git source skips source question and offers custom assets", async () => {
  const choices = fixture();
  choices.developerId = null;
  choices.scopes = choices.scopes.slice(0, 1);
  vi.mocked(select).mockResolvedValue("custom");
  vi.mocked(checkbox).mockImplementation(async (options) =>
    options.choices.slice(0, 1).map((c) => (c as { value: unknown }).value),
  );

  const result = await environmentChooser(vi.fn())(choices);
  expect(result.individualAssetIds).toEqual([choices.catalog.assets[0]!.id]);
  expect(checkbox).toHaveBeenCalledTimes(1);
});

test("git source checklist labels org, team and repository folders", async () => {
  const choices = fixture();
  choices.developerId = null;
  const repo = choices.scopes.find((s) => s.type === "repo")!;
  choices.previous = {
    ...choices.previous,
    subscriptions: [
      { scope: { type: "repo", id: repo.id }, mode: "all", enabled: true },
    ],
  };

  vi.mocked(checkbox).mockImplementation(async (options) =>
    options.choices.map((c) => (c as { value: unknown }).value),
  );

  vi.mocked(select).mockResolvedValue("all");
  await environmentChooser(vi.fn())(choices);
  const config = vi.mocked(checkbox).mock.calls[0]![0];
  const labels = config.choices.map((choice) => ({
    name: stripVTControlCharacters((choice as { name: string }).name),
    short: (choice as { short: string }).short,
  }));

  expect(config.message).toBe("What should this machine install from Acme?");
  // Only the organization, the member team and the already subscribed repository are offered.
  expect(labels).toEqual([
    {
      name: "Everyone     org/                3 assets  · suggested",
      short: "org/",
    },
    {
      name: "Engineering  teams/engineering/  0 assets",
      short: "teams/engineering/",
    },
    {
      name: "Repo 0       repos/repo-0/       0 assets",
      short: "repos/repo-0/",
    },
  ]);
});
