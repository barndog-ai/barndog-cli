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
  states: Record<string, "active" | "moved" | "invalid">;
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
      "skill:release-notes": "active",
      "hook:release-notes": "moved",
      "knowledge:context": "active",
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
      "skill:release-notes": "moved",
      "hook:release-notes": "moved",
      "knowledge:context": "active",
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
      "skill:release-notes": "active",
      "hook:release-notes": "active",
      "knowledge:context": "active",
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
      "skill:release-notes": "moved",
      "hook:release-notes": "moved",
      "knowledge:context": "moved",
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
      { to: "me", server: "http://127.0.0.1:9" },
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

    const states = Object.fromEntries(
      (await listLocalAssets(runtime)).assets.map((asset) => [
        keyOf(asset),
        asset.state,
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
    expect(
      await Promise.all(
        preservedPaths.map((path) => readFile(join(local.path, path), "utf8")),
      ),
    ).toEqual(before);
  });
}

test("local move uploads each asset under its own name to the chosen personal scope", async (t) => {
  const server = await cloud(t);
  const { runtime } = await localFixture(server);
  const { personal } = arrange(server, "publish");
  const sent = server.sent.length;

  await moveLocalAssets({ to: "me", server: "http://127.0.0.1:9" }, runtime);

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

test("failed moves stay active, so running the move again retries only them", async (t) => {
  const server = await cloud(t);
  const { runtime } = await localFixture(server);
  arrange(server, "failure");
  const first = await moveLocalAssets(
    { to: "me", server: "http://127.0.0.1:9" },
    runtime,
  );

  expect(first.rows.filter((row) => row.status === "failed")).toHaveLength(3);

  arrange(server, "publish");
  server.respond("POST", "/v1/skill-changes", sample(contract.changeSchema));
  server.respond("POST", "/v1/hook-changes", sample(contract.hookChangeSchema));

  server.respond(
    "POST",
    "/v1/knowledge/publish",
    sample(contract.knowledgeDocumentSchema),
  );

  const second = await moveLocalAssets(
    { to: "me", server: "http://127.0.0.1:9" },
    runtime,
  );

  expect(
    second.rows
      .filter((row) => row.status === "moved")
      .map(keyOf)
      .sort(),
  ).toEqual(["hook:release-notes", "knowledge:context", "skill:release-notes"]);

  const third = await moveLocalAssets(
    { to: "me", server: "http://127.0.0.1:9" },
    runtime,
  );

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

  const error = await moveLocalAssets({ as: "renamed" }, runtime).catch(
    (e: unknown) => e,
  );

  assert(error instanceof CliError);
  expect(error.message).toContain("name exactly one");
  expect(error.hint).toBe("barndog local move <name> --as <new-name>");
  expect(vi.mocked(synchronize)).not.toHaveBeenCalled();
});

test("moving an unknown name fails before anything is sent", async (t) => {
  const server = await cloud(t);
  const { runtime } = await localFixture(server);
  const sent = server.sent.length;

  const error = await moveLocalAssets({ names: ["missing"] }, runtime).catch(
    (e: unknown) => e,
  );

  assert(error instanceof CliError);
  expect(error.message).toBe("No local asset named missing.");
  expect(error.hint).toBe("barndog local list");
  expect(
    server.sent.slice(sent).filter((s) => s.request.startsWith("POST")),
  ).toEqual([]);
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
    { to: "org", names: ["release-notes"], as: "new-name", kind: "hook" },
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
    { to: "org", names: ["release-notes"], as: "new-name", kind: "skill" },
    runtime,
  );

  expect(
    server.sent.slice(sent).find((s) => s.request === "POST /v1/skill-changes")!
      .body,
  ).toMatchObject({ name: "new-name" });

  expect(files["SKILL.md"]).toMatch(/^name: new-name$/m);
});

test("renaming a knowledge document publishes it under the new name and marks the local file moved", async (t) => {
  const server = await cloud(t);
  const { runtime } = await localFixture(server);
  const result = await moveLocalAssets(
    { to: "org", names: ["context"], as: "renamed" },
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

  const local = (await listLocalAssets(runtime)).assets.find(
    (asset) => asset.kind === "knowledge",
  );

  expect(local).toMatchObject({ name: "context", state: "moved" });
  expect(vi.mocked(synchronize)).toHaveBeenCalledOnce();
});
