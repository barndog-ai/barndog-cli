import { beforeEach, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as contract from "@barndog-ai/api-contract";
import { migrate } from "../features/migration/migrate.js";
import { openRepoSource } from "../features/workspace/workspace-source.js";
import { localWorkspace } from "../features/workspace/setup.js";
import { localRepoSource } from "../features/workspace/repo-source.js";
import { barndogPaths } from "../config/paths.js";
import {
  saveSettings,
  readSettings,
  type Settings,
} from "../config/settings.js";
import { CliError } from "../errors.js";
import type { RepoSource } from "../features/workspace/repo-source.js";
import type {
  WorkspaceModel,
  RepoScope,
  RepoAsset,
} from "../features/workspace/format.js";
import { cloud, ID, packages } from "./cloud.js";
import { sample } from "./sample.js";
import { testRuntime } from "./runtime.js";

// There's no Git host here, so the Git workspace is a fixture model. Everything
// else runs for real: the local folder, the fake Cloud server and the sync that
// installs into the temporary home.
vi.mock("../features/workspace/workspace-source.js", async (original) => ({
  ...(await original<
    typeof import("../features/workspace/workspace-source.js")
  >()),
  openRepoSource: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

function source(model: WorkspaceModel): RepoSource {
  return {
    label: "fixture",
    cacheKey: "fixture",
    journal: { workspaceId: model.config.workspaceId },
    model: async () => model,
    catalog: async () => model.catalog,
    invalidAssets: async () => model.invalid,
    notices: () => [],
    packageFolder: vi.fn(),
    mcpDefinition: vi.fn(),
  };
}

function fixture(): WorkspaceModel {
  const org: RepoScope = {
    type: "org",
    id: randomUUID(),
    slug: "local",
    name: "Local",
    path: "org",
    canPublish: true,
  };

  const asset: RepoAsset = {
    id: randomUUID(),
    name: "release-notes",
    kind: "skill",
    origin: org,
    publishedVersion: "a".repeat(40),
    path: "org/skills/release-notes",
    description: "Release notes",
    entries: packages.skill.map((file) => ({
      path: file.path,
      data: Buffer.from(file.content, "base64"),
      executable: file.executable,
    })),
  };

  return {
    config: {
      version: 1,
      workspaceId: randomUUID(),
      name: "Fixture",
      teams: {},
      repositories: {},
      optional: [],
    },
    organizationId: org.id,
    scopes: [org],
    assets: [asset],
    knowledge: [],
    catalog: { assets: [asset], distributions: [] },
    invalid: new Map(),
    invalidKnowledge: [],
    problems: [],
  };
}

/** A real local workspace folder, kept beside the Git workspace, holding one Skill. */
async function keptFolder(home: string) {
  const runtime = testRuntime(home);
  const local = await localWorkspace(runtime);
  const skill = join(local.path, "org/skills/local-notes");
  await mkdir(skill, { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: local-notes\ndescription: Local notes\n---\nKeep notes.\n",
  );

  return { local, model: await localRepoSource(local, runtime).model() };
}

const installed = async (home: string, name: string) =>
  access(join(home, ".claude/skills", name)).then(
    () => true,
    () => false,
  );

for (const overlay of [false, true]) {
  test(`migration translates selection IDs and preserves kept local choices (overlay=${overlay})`, async (t) => {
    const server = await cloud(t);
    const model = fixture();
    const asset = model.assets[0]!;
    const extra = ["excluded", "disabled"].map((name) => ({
      ...asset,
      id: randomUUID(),
      name,
      entries: asset.entries.map((file) => ({
        ...file,
        data: Buffer.from(
          file.data.toString("utf8").replaceAll("release-notes", name),
        ),
      })),
    }));

    model.assets.push(...extra);
    vi.mocked(openRepoSource).mockReturnValue(source(model));
    const kept = overlay ? await keptFolder(server.home) : undefined;
    const keptSkill = kept?.model.assets[0]?.id;
    const settings = (await readSettings(server.home))!;
    const unknown = randomUUID();
    const selected = [asset.id, unknown, ...(keptSkill ? [keptSkill] : [])];
    const excludedId = "22222222-2222-4222-8222-222222222222";
    const disabledId = "33333333-3333-4333-8333-333333333333";
    await saveSettings(
      {
        ...settings,
        connection: undefined,
        harnesses: ["claude"],
        gitWorkspace: {
          url: "https://example.test/repo.git",
          branch: "main",
          workspaceId: model.config.workspaceId,
        },
        ...(kept ? { localWorkspace: kept.local } : {}),
        environment: {
          subscriptions: [
            {
              scope: { type: "org", id: model.organizationId },
              enabled: true,
              mode: "all",
            },
            ...(kept
              ? [
                  {
                    scope: {
                      type: "org" as const,
                      id: kept.model.organizationId,
                    },
                    enabled: true,
                    mode: "all" as const,
                  },
                ]
              : []),
          ],
          individualAssetIds: selected,
          disabledAssetIds: [extra[1]!.id, unknown],
          excludedAssetIds: [extra[0]!.id],
        },
      },
      server.home,
    );

    // What Cloud holds once the Git workspace's assets are published to its org.
    server.respond("GET", "/v1/environment/catalog", {
      assets: [
        sample(contract.environmentAssetSchema),
        sample(contract.environmentAssetSchema, {
          id: excludedId,
          name: "excluded",
        }),
        sample(contract.environmentAssetSchema, {
          id: disabledId,
          name: "disabled",
        }),
      ],
      distributions: [
        {
          scope: { type: "org", id: ID },
          assets: [ID, excludedId, disabledId].map((assetId) => ({
            assetId,
            mode: "recommended",
          })),
        },
      ],
    });

    const result = await migrate(
      { server: "http://127.0.0.1:9" },
      testRuntime(server.home),
    );

    expect(result.migrated).toBe(true);
    const saved = (await readSettings(server.home))!;
    expect(saved.gitWorkspace).toBeUndefined();
    expect(saved.environment!.individualAssetIds).toEqual(
      keptSkill ? [ID, keptSkill] : [ID],
    );

    expect(saved.environment!.disabledAssetIds).toEqual([disabledId]);
    expect(saved.environment!.excludedAssetIds).toEqual([excludedId]);
    expect(saved.environment!.subscriptions).toHaveLength(overlay ? 2 : 1);

    // The sync that ends the migration installs from Cloud, and from the kept folder.
    expect(await installed(server.home, "release-notes")).toBe(true);
    expect(await installed(server.home, "local-notes")).toBe(overlay);
    expect(await installed(server.home, "excluded")).toBe(false);
    expect(await installed(server.home, "disabled")).toBe(false);
    await expect(
      access(barndogPaths(server.home).pendingSync),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
}

test("dry run reports invalid, missing scopes, existing docs and pending publications without writes", async (t) => {
  const server = await cloud(t);
  const model = fixture();
  const asset = model.assets[0]!;
  model.assets.push(
    { ...asset, id: randomUUID(), name: "invalid", invalid: "bad manifest" },
    {
      ...asset,
      id: randomUUID(),
      name: "missing",
      origin: {
        ...asset.origin,
        type: "team",
        id: randomUUID(),
        slug: "absent",
      },
    },
    { ...asset, id: randomUUID(), name: "new" },
  );

  model.knowledge = [
    {
      id: randomUUID(),
      path: "knowledge/new.md",
      version: "a".repeat(40),
      content: sample(contract.knowledgeContentSchema, { name: "new" }),
    },
  ];

  vi.mocked(openRepoSource).mockReturnValue(source(model));
  const settings = (await readSettings(server.home))!;
  await saveSettings(
    {
      ...settings,
      connection: undefined,
      gitWorkspace: {
        url: "https://example.test/repo.git",
        branch: "main",
        workspaceId: model.config.workspaceId,
      },
    },
    server.home,
  );

  const options = { server: "http://127.0.0.1:9", dryRun: true };
  const result = await migrate(options, testRuntime(server.home));
  expect(result.rows.map((row) => row.action)).toEqual([
    "exists",
    "invalid",
    "missing-scope",
    "publish",
    "publish",
  ]);

  await expect(
    migrate({ ...options, dryRun: false }, testRuntime(server.home)),
  ).rejects.toThrow("Nothing was published");

  expect(server.requests.some((request) => request.startsWith("POST"))).toBe(
    false,
  );
});

/** Points this machine at the fixture's Git workspace, with `extra` settings. */
async function useGitWorkspace(
  home: string,
  model: WorkspaceModel,
  extra: Partial<Settings> = {},
) {
  const settings = (await readSettings(home))!;
  await saveSettings(
    {
      ...settings,
      connection: undefined,
      harnesses: [],
      gitWorkspace: {
        url: "https://example.test/repo.git",
        branch: "main",
        workspaceId: model.config.workspaceId,
      },
      ...extra,
    },
    home,
  );
}

test("local renames follow their assets to Cloud, keep the kept folder's, and drop ones for assets that are gone", async (t) => {
  const server = await cloud(t);
  const model = fixture();
  const kept = await keptFolder(server.home);
  const keptSkill = kept.model.assets[0]!.id;
  const gone = randomUUID();
  vi.mocked(openRepoSource).mockReturnValue(source(model));
  await useGitWorkspace(server.home, model, {
    localWorkspace: kept.local,
    localNames: {
      [model.assets[0]!.id]: "team-release-notes",
      [keptSkill]: "my-local-notes",
      [gone]: "old-name",
    },
  });

  server.respond("GET", "/v1/environment/catalog", {
    assets: [sample(contract.environmentAssetSchema)],
    distributions: [],
  });

  await migrate({ server: "http://127.0.0.1:9" }, testRuntime(server.home));

  expect((await readSettings(server.home))!.localNames).toEqual({
    [ID]: "team-release-notes",
    [keptSkill]: "my-local-notes",
  });
});

test("migration without renames leaves no localNames behind", async (t) => {
  const server = await cloud(t);
  const model = fixture();
  vi.mocked(openRepoSource).mockReturnValue(source(model));
  await useGitWorkspace(server.home, model, {
    localNames: { [randomUUID()]: "x" },
  });

  await migrate({ server: "http://127.0.0.1:9" }, testRuntime(server.home));

  expect((await readSettings(server.home))!.localNames).toBeUndefined();
});

test("a broken knowledge document blocks the migration like a broken asset, and nothing is published", async (t) => {
  const server = await cloud(t);
  const model = fixture();
  model.invalidKnowledge = [
    { path: "org/knowledge/broken.md", reason: "It has no name" },
  ];

  model.knowledge = [
    {
      id: randomUUID(),
      path: "org/knowledge/fine.md",
      version: "a".repeat(40),
      content: sample(contract.knowledgeContentSchema, { name: "fine" }),
    },
  ];

  vi.mocked(openRepoSource).mockReturnValue(source(model));
  await useGitWorkspace(server.home, model);
  const options = { server: "http://127.0.0.1:9" };

  const preview = await migrate(
    { ...options, dryRun: true },
    testRuntime(server.home),
  );

  expect(preview.rows).toContainEqual({
    kind: "knowledge",
    name: "broken",
    origin: "org",
    action: "invalid",
    detail: "org/knowledge/broken.md: It has no name",
  });

  const error: unknown = await migrate(options, testRuntime(server.home)).catch(
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(CliError);
  expect(error).toMatchObject({
    message: expect.stringContaining(
      "org/broken: org/knowledge/broken.md: It has no name",
    ),
    hint: "barndog migrate --to http://127.0.0.1:9 --dry-run",
  });

  expect(
    server.requests.filter((request) => request.startsWith("POST")),
  ).toEqual([]);

  expect((await readSettings(server.home))!.gitWorkspace).toBeDefined();
});

test("knowledge already in Cloud is found on any page of the knowledge list", async (t) => {
  const server = await cloud(t);
  const model = fixture();
  model.knowledge = [
    {
      id: randomUUID(),
      path: "org/knowledge/later.md",
      version: "a".repeat(40),
      content: sample(contract.knowledgeContentSchema, { name: "later" }),
    },
  ];

  vi.mocked(openRepoSource).mockReturnValue(source(model));
  await useGitWorkspace(server.home, model);
  const cursor = randomUUID();
  const index = sample(contract.knowledgeIndexSchema);
  const [listed] = index.documents;
  server.respond("GET", "/v1/knowledge", (request: Request) =>
    new URL(request.url).searchParams.get("cursor") === cursor
      ? {
          ...index,
          documents: [{ ...listed!, name: "later" }],
          nextCursor: null,
        }
      : { ...index, documents: [], nextCursor: cursor },
  );

  const { rows } = await migrate(
    { server: "http://127.0.0.1:9", dryRun: true },
    testRuntime(server.home),
  );

  expect(rows).toContainEqual(
    expect.objectContaining({
      kind: "knowledge",
      name: "later",
      action: "exists",
    }),
  );
});
