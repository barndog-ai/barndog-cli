import { HTTP_STATUS } from "../shared/constants.js";
import { assert, beforeEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { x } from "tar";
import * as contract from "@barndog-ai/api-contract";
import { cloud, packages, type Cloud } from "./cloud.js";
import { sample } from "./sample.js";
import { testRuntime } from "./runtime.js";
import { localWorkspace } from "../features/workspace/setup.js";
import { readSettings, saveSettings } from "../config/settings.js";
import { CliError } from "../shared/cli-error.js";
import { synchronize } from "../features/environment/sync.js";
import { readMoved, recordMoved } from "../features/workspace/overlay.js";
import { finishMoves } from "../features/environment/moves.js";
import { selectionState } from "../config/environment.js";
import {
  moveLocalAssets,
  listLocalAssets,
  cloudMoveTargets,
} from "../features/migration/move.js";

vi.mock("../features/environment/sync.js", () => ({
  synchronize: vi.fn().mockResolvedValue([]),
}));

beforeEach(() => {
  vi.mocked(synchronize).mockClear();
});

async function localFixture(server: { home: string }) {
  const runtime = testRuntime(server.home);
  const local = await localWorkspace(runtime);
  const settings = (await readSettings(server.home))!;
  await saveSettings({ ...settings, localWorkspace: local }, server.home);
  for (const kind of ["skill", "hook"] as const) {
    for (const file of packages[kind]) {
      const path = join(
        local.path,
        "org",
        `${kind}s`,
        "release-notes",
        file.path,
      );

      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(file.content, "base64"));
    }
  }

  await writeFile(
    join(local.path, "org/knowledge/context.md"),
    "---\ndescription: Local context\n---\nLocal knowledge\n",
  );

  await mkdir(join(local.path, "org/skills/broken"), { recursive: true });
  await writeFile(join(local.path, "org/skills/broken/SKILL.md"), "invalid");

  return { runtime, local };
}

const refuse = () =>
  Response.json(
    { message: "failure" },
    { status: HTTP_STATUS.internalServerError },
  );

/** What each local asset becomes after `moveLocalAssets`, by "kind:name". */
type Outcome = {
  rows: Record<string, { status: string; detail?: string }>;
  /** "removed" when the local copy is already gone. */
  states: Record<string, "available" | "moving" | "invalid" | "removed">;
  posted: string[];
  synced: boolean;
};

const modes: Record<"clash" | "denied" | "failure" | "publish", Outcome> = {
  clash: {
    rows: {
      "skill:release-notes": { status: "clash", detail: "Already in" },
      "hook:release-notes": { status: "moved" },
      "knowledge:context": { status: "clash", detail: "Name already used" },
      "skill:broken": { status: "skipped" },
    },
    states: {
      "skill:release-notes": "available",
      "hook:release-notes": "moving",
      "knowledge:context": "available",
      "skill:broken": "invalid",
    },
    posted: ["POST /v1/hook-changes"],
    synced: true,
  },
  denied: {
    rows: {
      "skill:release-notes": { status: "moved" },
      "hook:release-notes": { status: "moved" },
      "knowledge:context": {
        status: "skipped",
        detail: "Knowledge is organization-wide",
      },
      "skill:broken": { status: "skipped" },
    },
    states: {
      "skill:release-notes": "moving",
      "hook:release-notes": "moving",
      "knowledge:context": "available",
      "skill:broken": "invalid",
    },
    posted: ["POST /v1/skill-changes", "POST /v1/hook-changes"],
    synced: true,
  },
  failure: {
    rows: {
      "skill:release-notes": { status: "failed", detail: "failure" },
      "hook:release-notes": { status: "failed", detail: "failure" },
      "knowledge:context": { status: "failed", detail: "failure" },
      "skill:broken": { status: "skipped" },
    },
    states: {
      "skill:release-notes": "available",
      "hook:release-notes": "available",
      "knowledge:context": "available",
      "skill:broken": "invalid",
    },
    posted: [
      "POST /v1/skill-changes",
      "POST /v1/hook-changes",
      "POST /v1/knowledge/publish",
    ],
    synced: false,
  },
  publish: {
    rows: {
      "skill:release-notes": { status: "moved" },
      "hook:release-notes": { status: "moved" },
      "knowledge:context": { status: "moved" },
      "skill:broken": { status: "skipped" },
    },
    states: {
      "skill:release-notes": "moving",
      "hook:release-notes": "moving",
      "knowledge:context": "removed",
      "skill:broken": "invalid",
    },
    posted: [
      "POST /v1/skill-changes",
      "POST /v1/hook-changes",
      "POST /v1/knowledge/publish",
    ],
    synced: true,
  },
};

/** The fake server's scopes, catalog and knowledge for one scenario. */
function arrange(server: Cloud, mode: keyof typeof modes) {
  const org = sample(contract.scopeSchema, {
    type: "org",
    canPublish: mode !== "denied",
  });

  const personal = sample(contract.scopeSchema, {
    type: "dev",
    canPublish: true,
  });

  server.respond("GET", "/v1/scopes", [org, personal]);
  server.respond("GET", "/v1/environment/catalog", {
    assets:
      mode === "clash"
        ? [
            sample(contract.environmentAssetSchema, {
              kind: "skill",
              name: "release-notes",
              origin: { type: "dev", id: personal.id, slug: personal.slug },
            }),
          ]
        : [],
    distributions: [],
  });

  server.respond(
    "GET",
    "/v1/knowledge",
    sample(contract.knowledgeIndexSchema, {
      documents:
        mode === "clash"
          ? [
              sample(contract.knowledgeIndexSchema.shape.documents.element, {
                name: "context",
              }),
            ]
          : [],
    }),
  );

  if (mode === "failure") {
    for (const path of [
      "/v1/skill-changes",
      "/v1/hook-changes",
      "/v1/knowledge/publish",
    ]) {
      server.respond("POST", path, refuse);
    }
  }

  return { org, personal };
}

const keyOf = (item: { kind: string; name: string }) =>
  `${item.kind}:${item.name}`;

for (const mode of ["clash", "denied", "failure", "publish"] as const) {
  test(`local move to a personal scope: ${mode} leaves each asset in the state its outcome implies`, async (t) => {
    const server = await cloud(t);
    const { runtime, local } = await localFixture(server);
    const preservedPaths = [
      "org/skills/release-notes/SKILL.md",
      "org/hooks/release-notes/hook.yaml",
      "org/knowledge/context.md",
    ];

    const before = await Promise.all(
      preservedPaths.map((path) => readFile(join(local.path, path), "utf8")),
    );

    arrange(server, mode);
    const sent = server.sent.length;
    const expected = modes[mode];

    const result = await moveLocalAssets(
      { keepLocal: false, to: "me" },
      runtime,
    );

    expect(result.rows).toHaveLength(Object.keys(expected.rows).length);
    for (const row of result.rows) {
      const want = expected.rows[keyOf(row)];
      assert(want, `unexpected row ${keyOf(row)}`);
      expect(row.status, keyOf(row)).toBe(want.status);
      if (want.detail) {
        expect(row.detail, keyOf(row)).toContain(want.detail);
      }
    }

    const listed = (await listLocalAssets(runtime)).assets;
    const states = Object.fromEntries(
      Object.keys(expected.states).map((key) => [
        key,
        listed.find((asset) => keyOf(asset) === key)?.state ?? "removed",
      ]),
    );

    expect(states).toEqual(expected.states);
    expect(
      server.sent
        .slice(sent)
        .map((item) => item.request)
        .filter((request) =>
          /^POST \/v1\/(?:skill|hook)-changes$|publish/.test(request),
        ),
    ).toEqual(expected.posted);

    expect(vi.mocked(synchronize).mock.calls.length > 0).toBe(expected.synced);
    // Only knowledge goes at once; the rest waits for sync to see the shared copy.
    const kept = preservedPaths.filter(
      (path) =>
        !path.endsWith("context.md") ||
        expected.states["knowledge:context"] !== "removed",
    );

    expect(
      await Promise.all(
        kept.map((path) => readFile(join(local.path, path), "utf8")),
      ),
    ).toEqual(
      before.filter((_, index) => kept.includes(preservedPaths[index]!)),
    );
  });
}

test("local move uploads each asset under its own name to the chosen personal scope", async (t) => {
  const server = await cloud(t);
  const { runtime } = await localFixture(server);
  const { personal } = arrange(server, "publish");
  const sent = server.sent.length;

  await moveLocalAssets(
    { keepLocal: true, to: "me", server: "http://127.0.0.1:9" },
    runtime,
  );

  const bodies = Object.fromEntries(
    server.sent
      .slice(sent)
      .filter((item) =>
        /^POST \/v1\/(?:skill|hook)-changes$/.test(item.request),
      )
      .map((item) => [item.request, item.body]),
  );

  expect(bodies["POST /v1/skill-changes"]).toMatchObject({
    name: "release-notes",
    origin: { type: "dev", id: personal.id },
  });

  expect(bodies["POST /v1/hook-changes"]).toMatchObject({
    name: "release-notes",
    origin: { type: "dev", id: personal.id },
  });

  expect(
    server.sent.find((item) => item.request === "POST /v1/knowledge/publish")!
      .body,
  ).toMatchObject({ content: { name: "context" } });
});

test("failed moves stay available, so running the move again retries only them", async (t) => {
  const server = await cloud(t);
  const { runtime } = await localFixture(server);
  arrange(server, "failure");
  const first = await moveLocalAssets({ keepLocal: false, to: "me" }, runtime);

  expect(first.rows.filter((row) => row.status === "failed")).toHaveLength(3);

  arrange(server, "publish");
  server.respond("POST", "/v1/skill-changes", sample(contract.changeSchema));
  server.respond("POST", "/v1/hook-changes", sample(contract.hookChangeSchema));

  server.respond(
    "POST",
    "/v1/knowledge/publish",
    sample(contract.knowledgeDocumentSchema),
  );

  const second = await moveLocalAssets({ keepLocal: false, to: "me" }, runtime);

  expect(
    second.rows
      .filter((row) => row.status === "moved")
      .map(keyOf)
      .sort(),
  ).toEqual(["hook:release-notes", "knowledge:context", "skill:release-notes"]);

  const third = await moveLocalAssets({ keepLocal: false, to: "me" }, runtime);

  expect(third.rows.map(keyOf)).toEqual(["skill:broken"]);
});

test("cloud move targets list the personal scope", async (t) => {
  const server = await cloud(t);
  await localFixture(server);
  arrange(server, "publish");

  expect(await cloudMoveTargets(testRuntime(server.home))).toEqual(
    expect.arrayContaining([expect.objectContaining({ value: "me" })]),
  );
});

test("moving with --as requires exactly one name and tells the user how", async (t) => {
  const server = await cloud(t);
  const { runtime } = await localFixture(server);

  const error = await moveLocalAssets(
    { keepLocal: true, as: "renamed" },
    runtime,
  ).catch((e: unknown) => e);

  assert(error instanceof CliError);
  expect(error.message).toContain("name exactly one");
  expect(error.hint).toBe("barndog local move <name> --as <new-name>");
  expect(vi.mocked(synchronize)).not.toHaveBeenCalled();
});

test("moving an unknown name fails before anything is sent", async (t) => {
  const server = await cloud(t);
  const { runtime } = await localFixture(server);
  const sent = server.sent.length;

  const error = await moveLocalAssets(
    { keepLocal: true, names: ["missing"] },
    runtime,
  ).catch((e: unknown) => e);

  assert(error instanceof CliError);
  expect(error.message).toBe("No local asset named missing.");
  expect(error.hint).toBe("barndog local list");
  expect(
    server.sent.slice(sent).filter((s) => s.request.startsWith("POST")),
  ).toEqual([]);
});

test("a name that is only the start of another asset's name is still unknown", async (t) => {
  const server = await cloud(t);
  const { runtime } = await localFixture(server);

  const error = await moveLocalAssets(
    { keepLocal: true, names: ["release", "release-notes"] },
    runtime,
  ).catch((e: unknown) => e);

  assert(error instanceof CliError);
  expect(error.message).toBe("No local asset named release.");
});

/** Replaces a change route with one that records the uploaded package's files. */
function captureUpload(server: Cloud, path: string, reply: unknown) {
  const files: Record<string, string> = {};
  server.respond("POST", path, async (request: Request) => {
    const form = await request.formData();
    const upload = form.get("package");
    assert(upload instanceof Blob);
    const directory = await mkdtemp(join(server.home, "upload-"));
    const archive = join(directory, "package.tar.gz");
    await writeFile(archive, Buffer.from(await upload.arrayBuffer()));
    await x({ file: archive, cwd: directory });
    for (const name of ["SKILL.md", "hook.yaml"]) {
      try {
        files[name] = await readFile(join(directory, name), "utf8");
      } catch {
        // Not part of this package.
      }
    }

    return reply;
  });

  return files;
}

test("renaming a Hook uploads it under the new name and rewrites its hook.yaml", async (t) => {
  const server = await cloud(t);
  const { runtime, local } = await localFixture(server);
  const files = captureUpload(
    server,
    "/v1/hook-changes",
    sample(contract.hookChangeSchema, {
      status: "open",
      publishedVersion: null,
    }),
  );

  const sent = server.sent.length;
  const moved = await moveLocalAssets(
    {
      keepLocal: true,
      to: "org",
      names: ["release-notes"],
      as: "new-name",
      kind: "hook",
    },
    runtime,
  );

  expect(moved.rows).toEqual([
    expect.objectContaining({
      name: "new-name",
      kind: "hook",
      status: "moved",
    }),
  ]);

  expect(
    server.sent.slice(sent).find((s) => s.request === "POST /v1/hook-changes")!
      .body,
  ).toMatchObject({ name: "new-name" });

  expect(files["hook.yaml"]).toMatch(/^name: new-name$/m);
  expect(files["hook.yaml"]).not.toContain("name: release-notes");
  expect(
    await readFile(
      join(local.path, "org/hooks/release-notes/hook.yaml"),
      "utf8",
    ),
  ).toContain("name: release-notes");
});

test("renaming a Skill uploads it under the new name and rewrites its SKILL.md", async (t) => {
  const server = await cloud(t);
  const { runtime } = await localFixture(server);
  const files = captureUpload(
    server,
    "/v1/skill-changes",
    sample(contract.changeSchema, { status: "open", publishedVersion: null }),
  );

  const sent = server.sent.length;
  await moveLocalAssets(
    {
      keepLocal: true,
      to: "org",
      names: ["release-notes"],
      as: "new-name",
      kind: "skill",
    },
    runtime,
  );

  expect(
    server.sent.slice(sent).find((s) => s.request === "POST /v1/skill-changes")!
      .body,
  ).toMatchObject({ name: "new-name" });

  expect(files["SKILL.md"]).toMatch(/^name: new-name$/m);
});

test("moving a knowledge document under a new name removes the local file once it's published", async (t) => {
  const server = await cloud(t);
  const { runtime, local: folder } = await localFixture(server);
  const result = await moveLocalAssets(
    { keepLocal: false, to: "org", names: ["context"], as: "renamed" },
    runtime,
  );

  expect(result.rows).toEqual([
    expect.objectContaining({
      name: "renamed",
      kind: "knowledge",
      status: "moved",
    }),
  ]);

  expect(
    server.sent.find((s) => s.request === "POST /v1/knowledge/publish")!.body,
  ).toMatchObject({ content: { name: "renamed" } });

  expect(result.removed).toEqual([
    join(folder.path, "org/knowledge/context.md"),
  ]);

  expect(
    (await listLocalAssets(runtime)).assets.some(
      (asset) => asset.kind === "knowledge",
    ),
  ).toBe(false);

  expect(await readMoved(folder.path)).toEqual([]);
  expect(vi.mocked(synchronize)).toHaveBeenCalledOnce();
});

test("keeping local copies records nothing and leaves every local file", async (t) => {
  const server = await cloud(t);
  const { runtime, local: folder } = await localFixture(server);
  arrange(server, "publish");
  const result = await moveLocalAssets(
    { keepLocal: true, to: "me", server: "http://127.0.0.1:9" },
    runtime,
  );

  expect(result).toMatchObject({ keepLocal: true, removed: [] });
  expect(await readMoved(folder.path)).toEqual([]);
  expect(
    (await listLocalAssets(runtime)).assets.map((asset) => asset.state),
  ).not.toContain("moving");
});

test("a move to another server only copies, and moves this machine stopped using are dropped", async (t) => {
  const server = await cloud(t);
  const { runtime, local } = await localFixture(server);
  arrange(server, "publish");
  const result = await moveLocalAssets(
    { keepLocal: false, to: "me", server: "http://127.0.0.1:9" },
    runtime,
  );

  expect(result.keepLocal).toBe(true);
  expect(await readMoved(local.path)).toStrictEqual([]);

  // Recorded while connected, then the machine went local-only.
  await recordMoved(local.path, [
    { kind: "skill", name: "release-notes", path: "org/skills/release-notes" },
  ]);

  const settings = (await readSettings(server.home))!;
  const localOnly = { harnesses: settings.harnesses, localWorkspace: local };
  await saveSettings(localOnly, server.home);
  expect(
    (await listLocalAssets(runtime)).assets.map((asset) => asset.state),
  ).not.toContain("moving");

  const finished = await finishMoves({
    settings: localOnly,
    source: undefined,
    catalog: { assets: [], distributions: [] },
    selection: selectionState(localOnly),
    options: {},
    configPath: undefined,
    runtime,
  });

  expect(finished.notices).toStrictEqual([
    "This machine no longer uses the workspace release-notes was moving to, so its local copy stays as it is.",
  ]);

  expect(await readMoved(local.path)).toStrictEqual([]);
});
