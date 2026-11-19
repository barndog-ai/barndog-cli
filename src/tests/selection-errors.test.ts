import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { expect, test, type TestContext } from "vitest";
import { environmentAssetSchema } from "@barndog-ai/api-contract";
import {
  changeAsset,
  changeAssets,
  changeSet,
  installSet,
  installSetAssets,
  previewSet,
  renameAsset,
  switchSet,
} from "../features/environment/operations.js";
import { readSettings, saveSettings } from "../config/settings.js";
import { cloud, ID } from "./cloud.js";
import { sample } from "./sample.js";
import { testRuntime } from "./runtime.js";
import { CliError } from "../errors.js";

/** The rejection a promise ends with, so its class, message and hint can be checked. */
async function refusal(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(CliError);

  return error;
}

async function orgCatalog(t: TestContext) {
  const server = await cloud(t, { harnesses: [] });
  const runtime = testRuntime(server.home);
  const asset = sample(environmentAssetSchema);
  server.respond("GET", "/v1/environment/catalog", {
    assets: [asset],
    distributions: [
      {
        scope: { type: "org", id: ID },
        assets: [{ assetId: ID, mode: "recommended" }],
      },
    ],
  });

  return { server, runtime, asset };
}

const selection = async (home: string) =>
  (await readSettings(home))!.environment;

test("a set preview lists the scope's assets", async (t) => {
  const { runtime } = await orgCatalog(t);

  expect(await previewSet("org", runtime)).toMatchObject({
    assets: [{ id: ID }],
  });
});

test("switching only works between teams or repositories", async (t) => {
  const { runtime } = await orgCatalog(t);

  expect(await refusal(switchSet({ origin: "org" }, runtime))).toHaveProperty(
    "message",
    "Switch between teams or repositories, such as team/engineering or repo/web-app.",
  );
});

for (const origin of ["missing", "team", `dev/${randomUUID()}`]) {
  test(`installing or removing the unknown scope ${origin} is refused`, async (t) => {
    const { runtime } = await orgCatalog(t);

    for (const attempt of [
      () => installSet({ origin }, runtime),
      () => changeSet("remove", { origin }, runtime),
    ]) {
      expect(await refusal(attempt())).toHaveProperty(
        "message",
        expect.stringMatching(`^No scope named ${origin}`),
      );
    }
  });
}

test("an unavailable subscription can be removed by UUID, but not installed", async (t) => {
  const { server, runtime } = await orgCatalog(t);
  const absent = `team/${randomUUID()}`;

  expect(await refusal(installSet({ origin: absent }, runtime))).toHaveProperty(
    "message",
    expect.stringMatching(/^No scope named/),
  );

  await changeSet("remove", { origin: absent }, runtime);
  expect((await selection(server.home))?.subscriptions ?? []).toEqual([]);
});

test("enabling a scope you never subscribed to points at installing it", async (t) => {
  const { runtime } = await orgCatalog(t);

  expect(
    await refusal(changeSet("enable", { origin: "org" }, runtime)),
  ).toMatchObject({
    message: "org isn't in your sets yet.",
    hint: "barndog sets install org",
  });
});

test("choosing a scope's assets refuses duplicates and assets from elsewhere, separately", async (t) => {
  const { runtime } = await orgCatalog(t);
  const stranger = randomUUID();

  expect(
    await refusal(
      installSetAssets({ origin: "org", assetIds: [ID, ID] }, runtime),
    ),
  ).toHaveProperty(
    "message",
    `Each asset can be chosen once, but ${ID} is listed more than once.`,
  );

  expect(
    await refusal(
      installSetAssets({ origin: "org", assetIds: [stranger] }, runtime),
    ),
  ).toMatchObject({
    message: `${stranger} isn't one of org's assets.`,
    hint: "barndog sets show org",
  });
});

test("choosing no assets changes nothing", async (t) => {
  const { server, runtime } = await orgCatalog(t);
  const before = await selection(server.home);

  expect(
    await installSetAssets({ origin: "org", assetIds: [] }, runtime),
  ).toEqual({ status: "applied", events: [] });

  expect(
    await changeAssets("install", { kind: "skill", ids: [] }, runtime),
  ).toEqual({ status: "applied", events: [] });

  expect(await selection(server.home)).toEqual(before);
});

test("installing a set subscribes to it, and choosing its assets selects them individually", async (t) => {
  const { server, runtime } = await orgCatalog(t);

  await installSet({ origin: "org" }, runtime);
  expect((await selection(server.home))?.subscriptions).toEqual([
    expect.objectContaining({ scope: { type: "org", id: ID } }),
  ]);

  await installSetAssets({ origin: "org", assetIds: [ID] }, runtime);
  expect((await selection(server.home))?.individualAssetIds).toEqual([ID]);
});

async function twoScopes(t: TestContext) {
  const server = await cloud(t, { harnesses: [] });
  const runtime = testRuntime(server.home);
  const first = sample(environmentAssetSchema);
  const second = {
    ...first,
    id: randomUUID(),
    origin: { type: "team" as const, id: randomUUID(), slug: "web" },
  };

  server.respond("GET", "/v1/environment/catalog", {
    assets: [first, second],
    distributions: [],
  });

  return { server, runtime, first, second };
}

test("a name used in several scopes must be narrowed with --origin", async (t) => {
  const { runtime, first } = await twoScopes(t);

  expect(
    await refusal(
      changeAsset("install", { kind: "skill", name: first.name }, runtime),
    ),
  ).toHaveProperty(
    "message",
    `${first.name} exists in several scopes: org/${first.origin.slug}, team/web. Choose one with --origin.`.replace(
      `org/${first.origin.slug}`,
      "org",
    ),
  );
});

test("an unknown name is refused with or without an origin", async (t) => {
  const { runtime } = await twoScopes(t);

  for (const origin of [undefined, "org"]) {
    expect(
      await refusal(
        changeAsset(
          "install",
          { kind: "skill", name: "missing", origin },
          runtime,
        ),
      ),
    ).toHaveProperty(
      "message",
      expect.stringMatching(/^No Skill named missing/),
    );
  }
});

test("installing with --origin selects that scope's asset", async (t) => {
  const { server, runtime, first } = await twoScopes(t);

  await changeAsset(
    "install",
    { kind: "skill", name: first.name, origin: "org" },
    runtime,
  );

  expect((await selection(server.home))?.individualAssetIds).toEqual([ID]);
});

test("an asset selected earlier can be removed by its ID after it leaves the catalog", async (t) => {
  const { server, runtime } = await twoScopes(t);
  const stale = randomUUID();
  const settings = (await readSettings(server.home))!;
  await saveSettings(
    {
      ...settings,
      environment: {
        subscriptions: [],
        individualAssetIds: [stale],
        excludedAssetIds: [],
        disabledAssetIds: [],
      },
    },
    server.home,
  );

  await changeAsset("remove", { kind: "skill", name: stale }, runtime);

  expect((await selection(server.home))?.individualAssetIds).toEqual([]);
});

test("a rename is saved, can be used as the name, and is dropped by --reset or the published name", async (t) => {
  const { server, runtime, first } = await twoScopes(t);
  const names = async () => (await readSettings(server.home))?.localNames;

  await renameAsset({ kind: "skill", name: ID, as: "local-name" }, runtime);
  expect(await names()).toEqual({ [ID]: "local-name" });

  await changeAsset("disable", { kind: "skill", name: "local-name" }, runtime);
  expect((await selection(server.home))?.disabledAssetIds).toContain(ID);

  await renameAsset({ kind: "skill", name: ID, reset: true }, runtime);
  expect(await names()).toBeUndefined();

  await renameAsset({ kind: "skill", name: ID, as: "local-name" }, runtime);
  await renameAsset({ kind: "skill", name: ID, as: first.name }, runtime);
  expect(await names()).toBeUndefined();
});

test("a rename needs a valid name, and says to pass --as or --reset when given neither", async (t) => {
  const { server, runtime } = await twoScopes(t);

  expect(
    await refusal(
      renameAsset({ kind: "skill", name: ID, as: "Bad Name" }, runtime),
    ),
  ).toHaveProperty(
    "message",
    "Names use lowercase letters, numbers and single hyphens, at most 64 characters.",
  );

  expect(
    await refusal(renameAsset({ kind: "skill", name: ID }, runtime)),
  ).toMatchObject({
    message: `Say what to rename ${ID} to.`,
    hint: `barndog skills rename ${ID} --as <new-name>, or --reset for its published name`,
  });

  expect((await readSettings(server.home))?.localNames).toBeUndefined();
});

test("a rename to a name another installed asset uses is refused", async (t) => {
  const { server, runtime, first, second } = await twoScopes(t);
  await changeAsset(
    "install",
    { kind: "skill", name: first.name, origin: "team/web" },
    runtime,
  );

  await changeAsset(
    "install",
    { kind: "skill", name: first.name, origin: "org" },
    runtime,
  ).catch(() => undefined);

  await renameAsset({ kind: "skill", name: second.id, as: "taken" }, runtime);
  expect(
    await refusal(
      renameAsset({ kind: "skill", name: ID, as: "taken" }, runtime),
    ),
  ).toHaveProperty("message", "taken is already used by team/web.");

  expect((await readSettings(server.home))?.localNames).toEqual({
    [second.id]: "taken",
  });
});

/** An org set whose one asset you excluded and disabled earlier. */
async function overridden(t: TestContext) {
  const { server, runtime } = await orgCatalog(t);
  const settings = (await readSettings(server.home))!;
  await saveSettings(
    {
      ...settings,
      environment: {
        subscriptions: [],
        individualAssetIds: [],
        excludedAssetIds: [ID],
        disabledAssetIds: [ID],
      },
    },
    server.home,
  );

  return { server, runtime, path: join(server.home, "decisions.json") };
}

test("reinstalling a set over your own exclusions asks for a decision first", async (t) => {
  const { runtime } = await overridden(t);

  expect(await installSet({ origin: "org" }, runtime)).toMatchObject({
    status: "decision-required",
    conflicts: [
      expect.objectContaining({ asset: expect.objectContaining({ id: ID }) }),
    ],
  });
});

test("a decisions file clears the overrides it names", async (t) => {
  const { server, runtime, path } = await overridden(t);
  await writeFile(path, JSON.stringify([{ assetId: ID, choice: "clear" }]));

  expect(
    await installSet({ origin: "org", decisions: path }, runtime),
  ).toMatchObject({ status: "applied" });

  const after = await selection(server.home);
  expect(after?.excludedAssetIds).not.toContain(ID);
  expect(after?.disabledAssetIds).not.toContain(ID);
});

const FORMAT_FIX =
  'Write a list such as [{"assetId": "<uuid>", "choice": "preserve"}], with "preserve" or "clear" for each asset';

for (const [damage, text, message] of [
  ["isn't JSON", "{", "decisions.json isn't valid JSON."],
  [
    "isn't a list",
    "{}",
    "decisions.json isn't a decisions file: Invalid input: expected array, received object.",
  ],
] as const) {
  test(`a decisions file that ${damage} is named in the error, with the expected format`, async (t) => {
    const { server, runtime } = await overridden(t);
    await writeFile(join(server.home, "decisions.json"), text);
    const before = await selection(server.home);

    expect(
      await refusal(
        installSet(
          { origin: "org", decisions: "decisions.json" },
          {
            ...runtime,
            cwd: server.home,
          },
        ),
      ),
    ).toMatchObject({ message, hint: FORMAT_FIX });

    expect(await selection(server.home)).toEqual(before);
  });
}
