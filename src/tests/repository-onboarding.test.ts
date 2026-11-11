import { test } from "node:test";
import assert from "node:assert/strict";
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
import { collaborate } from "../features/collaboration/index.js";

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
  assert.equal(
    normalizeRepositoryRemote("git@github.com:Acme/Demo.git"),
    "github.com/acme/demo",
  );
  assert.equal(
    normalizeRepositoryRemote("https://github.com/acme/demo.git"),
    "github.com/acme/demo",
  );
  assert.equal(
    normalizeRepositoryRemote("ssh://git@git.acme.test/Team/Repo.git"),
    "git.acme.test/Team/Repo",
  );
  assert.equal(
    normalizeRepositoryRemote("https://secret:password@github.com/acme/repo"),
    null,
  );
  assert.equal(normalizeRepositoryRemote("/local/repo"), null);
});

test("connected onboarding loads actual membership without using repository suggestions and preserves state on cancellation", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "barndog-init-context-"));
  t.after(() => rm(home, { recursive: true, force: true }));
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
    assert.equal(req.headers.authorization, `Bearer ${"a".repeat(43)}`);
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
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
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
      assert.deepEqual(choices.memberTeamIds, [team]);
      assert.deepEqual(choices.previous.subscriptions, []);
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
  assert.equal(saved?.version, 2);
  assert.deepEqual((saved as SettingsV2).environment?.excludedAssetIds, [
    asset,
  ]);
  assert.equal((saved as SettingsV2).knowledge, false);
  assert.equal(
    (saved as SettingsV2).environment?.subscriptions[0]?.mode,
    "optional",
  );
  const before = await readFile(settingsPath(home), "utf8");
  await assert.rejects(
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
    /cancelled/,
  );
  assert.equal(await readFile(settingsPath(home), "utf8"), before);
  const unrelated = await localRepository(home);
  assert.equal(unrelated.root, null);
  ambiguous = true;
  const ambiguousContext = await repositoryContext(home, cwd);
  assert.equal(ambiguousContext.ambiguous, true);
  assert.equal(ambiguousContext.repository, null);
  assert.deepEqual(ambiguousContext.policyScopes, [{ type: "org", id: org }]);
  // Outside a working copy, status defers to the machine overview.
  assert.deepEqual(await collaborate("status", {}, home, home), {
    mode: "environment",
  });
});

test("inspection command routing is separate from working-copy workflows", async () => {
  const calls: string[] = [];
  const program = createProgram({
    capability: async (action) => {
      calls.push(action);
      return {};
    },
    write: () => {},
  });
  for (const args of [
    ["open", "--no-browser"],
    ["repo", "status"],
  ])
    await program.parseAsync(args, { from: "user" });
  assert.deepEqual(calls, ["open", "repo-status"]);
});

test("local-only environment inspection and synchronization preview need no server", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "barndog-local-inspect-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await saveSettings(
    { version: 1, harnesses: ["claude", "codex"], skills: [] },
    home,
  );
  const before = await readFile(settingsPath(home), "utf8");
  const diff = (await collaborate("diff", {}, home, home)) as {
    mode: string;
    events: unknown[];
  };
  assert.equal(diff.mode, "environment-preview");
  assert.deepEqual(diff.events, []);
  assert.equal(await readFile(settingsPath(home), "utf8"), before);
});
