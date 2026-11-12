import { expect, test } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { normalizeRepositoryRemote } from "@barndog-ai/api-contract";
import { initialize } from "../features/onboarding/setup.js";
import {
  readSettings,
  saveSettings,
  settingsPath,
  type SettingsV2,
} from "../config/settings.js";
import { updateCredentials } from "../features/auth/credentials.js";
import {
  repositoryContext,
  localRepository,
} from "../features/repositories/context.js";
import { createProgram } from "../program.js";
import { workingDiff, workingStatus } from "../features/collaboration/index.js";

const org = randomUUID(),
  developer = randomUUID(),
  team = randomUUID(),
  repo = randomUUID(),
  asset = randomUUID();
const context = {
  organization: { id: org, name: "Pack", slug: "pack" },
  developer: {
    id: developer,
    name: "Alice",
    slug: "alice",
    role: "developer" as const,
  },
};

test("repository remote identities preserve host/path and discard transport/user differences", () => {
  expect(normalizeRepositoryRemote("git@github.com:Acme/Demo.git")).toBe(
    "github.com/acme/demo",
  );
  expect(normalizeRepositoryRemote("https://github.com/acme/demo.git")).toBe(
    "github.com/acme/demo",
  );
  expect(
    normalizeRepositoryRemote("ssh://git@git.acme.test/Team/Repo.git"),
  ).toBe("git.acme.test/Team/Repo");
  expect(
    normalizeRepositoryRemote("https://secret:password@github.com/acme/repo"),
  ).toBe(null);
  expect(normalizeRepositoryRemote("/local/repo")).toBe(null);
});

test("connected onboarding loads actual membership without using repository suggestions and preserves state on cancellation", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "barndog-init-context-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const cwd = join(home, "project");
  await mkdir(cwd);
  execFileSync("git", ["init", cwd], { stdio: "ignore" });
  execFileSync("git", [
    "-C",
    cwd,
    "remote",
    "add",
    "origin",
    "git@github.com:acme/demo.git",
  ]);
  let ambiguous = false;
  const mapped = {
    id: repo,
    name: "Demo",
    slug: "demo",
    teamId: team,
    visibility: "organization",
    gitRemote: "github.com/acme/demo",
    canManage: false,
    canInvite: false,
  };
  const server = createServer((req, res) => {
    expect(req.headers.authorization).toBe(`Bearer ${"a".repeat(43)}`);
    const data: Record<string, unknown> = {
      "/v1/context": context,
      [`/v1/teams/${team}/members`]: [
        { id: developer, name: "Alice", role: "member" },
      ],
      "/v1/scopes": [
        { type: "org", ...context.organization, canPublish: false },
        {
          type: "team",
          id: team,
          name: "Engineering",
          slug: "engineering",
          canPublish: false,
        },
        {
          type: "repo",
          id: repo,
          name: "Demo",
          slug: "demo",
          canPublish: false,
        },
      ],
      "/v1/repositories": ambiguous
        ? [mapped, { ...mapped, id: randomUUID(), slug: "duplicate" }]
        : [mapped],
      "/v1/teams": [
        {
          id: team,
          name: "Engineering",
          slug: "engineering",
          visibility: "organization",
          canManage: false,
          canInvite: false,
        },
      ],
      "/v1/environment/catalog": {
        assets: [
          {
            id: asset,
            kind: "skill",
            name: "review",
            origin: { type: "team", id: team, slug: "engineering" },
            publishedVersion: randomUUID(),
          },
        ],
        distributions: [
          { scope: { type: "org", id: org }, assets: [] },
          {
            scope: { type: "team", id: team },
            assets: [{ assetId: asset, mode: "recommended" }],
          },
          { scope: { type: "repo", id: repo }, assets: [] },
        ],
      },
    };
    res.setHeader("Content-Type", "application/json");
    if (!(req.url! in data)) {
      res.statusCode = 404;
      res.end(JSON.stringify({ code: "NOT_FOUND", message: req.url }));
      return;
    }
    res.end(JSON.stringify(data[req.url!]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.onTestFinished(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  await updateCredentials(home, (credentials) => {
    credentials.selectedServer = url;
    credentials.servers[url] = {
      token: "a".repeat(43),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      context,
    };
  });
  const settings: SettingsV2 = {
    version: 2,
    harnesses: [],
    skills: [],
    knowledge: false,
    connection: { server: url, organizationId: org, developerId: developer },
    environment: {
      subscriptions: [],
      individualAssetIds: [],
      excludedAssetIds: [asset],
      disabledAssetIds: [asset],
    },
  };
  await saveSettings(settings, home);
  await initialize({
    home,
    cwd,
    server: url,
    choose: async () => [],
    detected: [],
    chooseEnvironment: async (choices) => {
      expect(choices.memberTeamIds).toStrictEqual([team]);
      expect(choices.previous.subscriptions).toStrictEqual([]);
      return {
        ...choices.previous,
        subscriptions: [
          {
            scope: { type: "team", id: team },
            mode: "optional",
            enabled: true,
          },
        ],
        individualAssetIds: [asset],
      };
    },
  });
  const saved = await readSettings(home);
  expect(saved?.version).toBe(2);
  expect((saved as SettingsV2).environment?.excludedAssetIds).toStrictEqual([
    asset,
  ]);
  expect((saved as SettingsV2).knowledge).toBe(false);
  expect((saved as SettingsV2).environment?.subscriptions[0]?.mode).toBe(
    "optional",
  );
  const before = await readFile(settingsPath(home), "utf8");
  await expect(
    initialize({
      home,
      cwd,
      server: url,
      detected: [],
      choose: async () => ["claude"],
      chooseEnvironment: async () => {
        throw new Error("cancelled");
      },
    }),
  ).rejects.toThrow(/cancelled/);
  expect(await readFile(settingsPath(home), "utf8")).toBe(before);
  const unrelated = await localRepository(home);
  expect(unrelated.root).toBe(null);
  ambiguous = true;
  const ambiguousContext = await repositoryContext(home, cwd);
  expect(ambiguousContext.ambiguous).toBe(true);
  expect(ambiguousContext.repository).toBe(null);
  expect(ambiguousContext.policyScopes).toStrictEqual([
    { type: "org", id: org },
  ]);
  // Outside a working copy, status defers to the machine overview.
  expect(await workingStatus(home, home)).toStrictEqual({
    mode: "environment",
  });
});

test("inspection command routing is separate from working-copy workflows", async () => {
  const calls: string[] = [];
  const program = createProgram({
    workspaceUrl: async () => {
      calls.push("open");
      return "https://barndog.example.com";
    },
    repoStatus: async () => {
      calls.push("repo-status");
      return {
        root: null,
        remotes: [],
        repository: null,
        team: null,
        ambiguous: false,
        policyScopes: [],
      };
    },
    write: () => {},
  });
  for (const args of [
    ["open", "--no-browser"],
    ["repo", "status"],
  ])
    await program.parseAsync(args, { from: "user" });
  expect(calls).toStrictEqual(["open", "repo-status"]);
});

test("local-only environment inspection and synchronization preview need no server", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "barndog-local-inspect-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  await saveSettings(
    { version: 1, harnesses: ["claude", "codex"], skills: [] },
    home,
  );
  const before = await readFile(settingsPath(home), "utf8");
  const diff = (await workingDiff(home, home)) as {
    mode: string;
    events: unknown[];
  };
  expect(diff.mode).toBe("environment-preview");
  expect(diff.events).toStrictEqual([]);
  expect(await readFile(settingsPath(home), "utf8")).toBe(before);
});
