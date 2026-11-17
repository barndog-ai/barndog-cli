import { expect, test } from "vitest";
import { appendFile, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import * as contract from "@barndog-ai/api-contract";
import { inventory, type InventoryState } from "../features/inventory/index.js";
import {
  readSettings,
  saveSettings,
  type Settings,
} from "../config/settings.js";
import { barndogPaths } from "../config/paths.js";
import { HTTP_STATUS } from "../shared/constants.js";
import { cloud, HOOK_ID, ID, type Cloud } from "./cloud.js";
import { sample } from "./sample.js";
import { testRuntime } from "./runtime.js";

// Every case starts from a real sync against the fake server and then changes
// what a person or the server could change: a file in the installed folder, the
// harness link, the published version, the selection, or reachability.

const NEWER_VERSION = "44444444-4444-4444-8444-444444444444";

/** The fake server's catalog: one Skill and one Hook, both named release-notes. */
function catalog(skillVersion?: string) {
  const asset = sample(contract.environmentAssetSchema);

  return contract.environmentCatalogSchema.parse({
    assets: [
      {
        ...asset,
        kind: "skill",
        id: ID,
        publishedVersion: skillVersion ?? asset.publishedVersion,
      },
      { ...asset, kind: "hook", id: HOOK_ID },
    ],
    distributions: [],
  });
}

function selection(
  individualAssetIds: string[],
  disabledAssetIds: string[] = [],
): Settings["environment"] {
  return {
    subscriptions: [],
    individualAssetIds,
    excludedAssetIds: [],
    disabledAssetIds,
  };
}

async function select(server: Cloud, environment: Settings["environment"]) {
  const settings = await readSettings(server.home);
  await saveSettings({ ...settings!, environment }, server.home);
}

const skillFolder = (home: string) =>
  join(barndogPaths(home).installed("skill"), "release-notes");

const skillLink = (home: string) => join(home, ".claude/skills/release-notes");

async function editInstalledSkill(server: Cloud) {
  await appendFile(join(skillFolder(server.home), "SKILL.md"), "\nHand edit\n");
}

function publishNewerVersion(server: Cloud) {
  server.respond("GET", "/v1/environment/catalog", catalog(NEWER_VERSION));
}

type Step = (server: Cloud) => Promise<void> | void;

const sync: Step = async (server) => {
  await server.run(["sync"]);
};

const disable: Step = (server) => select(server, selection([ID], [ID]));

const selectedCases: [string, Step[], InventoryState][] = [
  ["installed and untouched", [sync], "installed"],
  ["selected but never synced", [], "pending"],
  ["installed folder edited by hand", [sync, editInstalledSkill], "modified"],
  ["newer version published", [sync, publishNewerVersion], "outdated"],
  [
    "edited and a newer version published",
    [sync, editInstalledSkill, publishNewerVersion],
    "modified",
  ],
  ["disabled after installing", [sync, disable], "disabled"],
  [
    "disabled and edited by hand",
    [sync, editInstalledSkill, disable],
    "disabled",
  ],
  ["disabled before installing", [disable], "disabled"],
];

for (const [situation, steps, expected] of selectedCases) {
  test(`a selected Skill ${situation} is ${expected}`, async (t) => {
    const server = await cloud(t, {
      harnesses: ["claude"],
      environment: selection([ID]),
    });

    server.respond("GET", "/v1/environment/catalog", catalog());
    for (const step of steps) {
      await step(server);
    }

    const { items } = await inventory(testRuntime(server.home));
    expect(items.find((item) => item.id === ID)).toMatchObject({
      name: "release-notes",
      state: expected,
      via: ["individual"],
    });
  });
}

async function installThenUnselect(t: Parameters<typeof cloud>[0]) {
  const server = await cloud(t, {
    harnesses: ["claude"],
    environment: selection([ID, HOOK_ID]),
  });

  server.respond("GET", "/v1/environment/catalog", catalog());
  await server.run(["sync"]);
  await select(server, selection([]));

  return server;
}

test("unselected installed assets are reported as removing, under their installed names", async (t) => {
  const server = await installThenUnselect(t);

  const result = await inventory(testRuntime(server.home));
  expect(result.offline).toBeNull();
  expect(
    result.items.map(({ id, kind, name, state }) => ({
      id,
      kind,
      name,
      state,
    })),
  ).toEqual(
    expect.arrayContaining([
      { id: ID, kind: "skill", name: "release-notes", state: "removing" },
      // Hook folders always carry their origin (hookFolders() in names.ts).
      {
        id: HOOK_ID,
        kind: "hook",
        name: "org-acme-release-notes",
        state: "removing",
      },
    ]),
  );
});

test("when the server can't be reached, installed assets are still reported as installed", async (t) => {
  const server = await installThenUnselect(t);
  server.respond(
    "GET",
    "/v1/environment/catalog",
    () =>
      new Response("unavailable", {
        status: HTTP_STATUS.internalServerError,
      }),
  );

  const result = await inventory(testRuntime(server.home));
  expect(result.offline).toEqual(expect.any(String));
  expect(result.items.find((item) => item.id === ID)?.state).toBe("installed");
  expect(result.items.find((item) => item.id === HOOK_ID)?.state).toBe(
    "installed",
  );
});

test("an unselected Skill whose harness link was repointed by hand is modified", async (t) => {
  const server = await installThenUnselect(t);
  const elsewhere = join(server.home, "elsewhere");
  await mkdir(elsewhere);
  await rm(skillLink(server.home));
  await symlink(elsewhere, skillLink(server.home), "junction");

  const { items } = await inventory(testRuntime(server.home));
  expect(items.find((item) => item.id === ID)?.state).toBe("modified");
});
