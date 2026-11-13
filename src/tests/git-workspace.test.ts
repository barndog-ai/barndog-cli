import { assert, expect, test, type TestContext } from "vitest";
import { execFile } from "node:child_process";
import { builtRoot, sourceRoot } from "./built.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { defaultServer } from "../config/build.js";
import { readSettings, saveSettings } from "../config/settings.js";
import { z } from "zod";

import { CliError, friendlyMessage } from "../errors.js";
import { updateCredentials } from "../features/auth/credentials.js";
import { searchCatalog } from "../features/catalog/index.js";
import {
  createPackage,
  diffVersions,
  listChanges,
  packageVersions,
  pullPackage,
  pushWorkingCopy,
  resolveFile,
  updateWorkingCopy,
  workingStatus,
} from "../features/collaboration/index.js";
import { developers, promote } from "../features/discovery/index.js";
import { doctor } from "../features/doctor/index.js";
import { validateFolder } from "../features/git-workspace/assets.js";
import { migrate } from "../features/git-workspace/migrate.js";
import {
  listLocalAssets,
  moveLocalAssets,
} from "../features/git-workspace/move.js";
import { updateImported } from "../features/imports/local.js";
import { repoStatus } from "../features/inspection/index.js";
import {
  changeAsset,
  installSet,
  renameAsset,
} from "../features/environment/operations.js";
import { synchronize } from "../features/environment/sync.js";
import { loadWorkspace, stableId } from "../features/git-workspace/format.js";
import { checkRepositoryUrl } from "../features/git-workspace/git.js";
import { cloneGitWorkspace } from "../features/git-workspace/setup.js";
import { compareUrl } from "../features/git-workspace/publish.js";
import { folderSnapshot } from "../features/git-workspace/snapshot.js";
import { originLabel } from "../features/environment/names.js";
import { environmentChooser } from "../ui/environment-onboarding.js";
import { knowledgeGet, knowledgeList } from "../features/knowledge/index.js";
import { inventory } from "../features/inventory/index.js";
import { initialize } from "../features/onboarding/setup.js";
import { assertCommandAvailable } from "../commands/availability.js";
import { createProgram } from "../program.js";
import { renderCollaboration } from "../ui/collaboration.js";
import { renderMove } from "../ui/move.js";
import {
  addHook,
  addMcp,
  addSkills,
  pickHookPlan,
  type AddPrompts,
} from "../ui/add-asset.js";
import {
  discoverHooks,
  discoverSkills,
  scopeExists,
} from "../features/imports/discover.js";
import {
  addMcpServers,
  convertServer,
  harnessServers,
  parseMcpText,
} from "../features/imports/mcp.js";
import { parse } from "yaml";

import { saveImported } from "../features/imports/local.js";
import { adaptHook, adaptPrompt } from "../features/hooks/adapt.js";
import { folderDivergence } from "../features/hooks/divergence.js";
import { hookCommand } from "../features/native/adapters.js";
import { fetchRemote, parseLocation } from "../features/imports/remote.js";
import { runSetup } from "../ui/onboarding.js";

const execute = promisify(execFile);

process.env.GIT_AUTHOR_NAME = "Test";
process.env.GIT_AUTHOR_EMAIL = "test@example.com";
process.env.GIT_COMMITTER_NAME = "Test";
process.env.GIT_COMMITTER_EMAIL = "test@example.com";

type T = TestContext;

const run = async (cwd: string, ...args: string[]) =>
  (await execute("git", args, { cwd })).stdout.trim();

async function write(root: string, path: string, text: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

const skill = (name: string, body = "Do the thing.") =>
  `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}\n`;

const hookYaml = `name: audit
description: Log commands.
implementations:
  claude:
    compatibility: supported
    scripts: [audit.sh]
    events:
      PreToolUse:
        - matcher: Bash
          hooks:
            - command: \${BARNDOG_HOOK_ROOT}/audit.sh
`;

const mcpYaml = `description: Search docs.
transport: http
url: https://docs.example.com/mcp
authentication: environment
headers:
  Authorization:
    secretRef: DOCS_TOKEN
`;

const knowledgeMd = `---
description: Where code belongs.
tags: [architecture]
accessMode: always
---
# Architecture
`;

async function addAssets(root: string) {
  await write(root, "org/skills/code-review/SKILL.md", skill("code-review"));
  await write(root, "org/skills/code-review/references/a.txt", "supporting");
  await write(root, "org/hooks/audit/hook.yaml", hookYaml);
  await write(root, "org/hooks/audit/audit.sh", "#!/bin/sh\ncat >/dev/null\n");
  await chmod(join(root, "org/hooks/audit/audit.sh"), 0o755);
  await write(root, "org/mcp/docs.yaml", mcpYaml);
  await write(root, "org/knowledge/architecture.md", knowledgeMd);
  await write(root, "teams/web/skills/lint/SKILL.md", skill("lint"));
}

async function temp(t: T) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "barndog-git-")));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

const orgOnly = async (choices: {
  scopes: { type: string; id: string }[];
  previous: { excludedAssetIds: readonly string[] };
}) => ({
  subscriptions: [
    {
      scope: { type: "org" as const, id: choices.scopes[0]!.id },
      mode: "all" as const,
      enabled: true,
    },
  ],
  individualAssetIds: [],
  excludedAssetIds: [],
  disabledAssetIds: [],
});

async function setupLocal(home: string) {
  await runSetup({
    home,
    local: true,
    restart: true,
    interactive: true,
    detected: [],
    write: () => {},
    confirmRestart: async () => true,
    confirmApply: async () => true,
    choose: async () => ["claude"],
  });
  const settings = await readSettings(home);
  assert(settings?.localWorkspace);
  return settings.localWorkspace.path;
}

type LocalChoice = "keep" | "move" | "leave";

const everyScope = async (choices: {
  scopes: { type: string; id: string }[];
}) => ({
  subscriptions: choices.scopes.map((scope) => ({
    scope,
    mode: "all" as const,
    enabled: true,
  })),
  individualAssetIds: [],
  excludedAssetIds: [],
  disabledAssetIds: [],
});

async function setupGit(
  url: string,
  home: string,
  local?: LocalChoice,
  chooseEnvironment: unknown = orgOnly,
) {
  const output: string[] = [];
  await runSetup({
    home,
    repo: url,
    restart: true,
    interactive: true,
    browser: false,
    detected: [],
    write: (line) => output.push(line),
    confirmRestart: async () => true,
    confirmCreateRepo: async () => true,
    confirmApply: async () => true,
    choose: async () => ["claude"],
    chooseEnvironment: chooseEnvironment as never,
    ...(local ? { chooseLocalAssets: async () => local } : {}),
  });
  return output.join("\n");
}

/** An empty team repo, set up by an admin whose assets are already merged. */
async function teamRepo(t: T) {
  const root = await temp(t);
  const url = join(root, "team.git");
  await run(root, "init", "--bare", "--initial-branch=main", url);
  const admin = join(root, "admin");
  const output = await setupGit(url, admin);
  const clone = join(root, "clone");
  await run(root, "clone", url, clone);
  await addAssets(clone);
  await run(clone, "add", ".");
  await run(clone, "commit", "-m", "Add assets");
  await run(clone, "push", "origin", "main");
  return { root, url, admin, clone, output };
}

const commit = async (clone: string, message: string) => {
  await run(clone, "add", ".");
  await run(clone, "commit", "-m", message);
  await run(clone, "push", "origin", "HEAD");
};

const installed = (home: string, path: string) =>
  readFile(join(home, ".barndog/installed", path), "utf8");

const gitWorkspaceId = async (home: string) => {
  const settings = await readSettings(home);
  assert(settings?.gitWorkspace);
  return settings.gitWorkspace.workspaceId;
};

const claudeSettings = async (home: string) =>
  JSON.parse(await readFile(join(home, ".claude/settings.json"), "utf8"));

test("folder snapshots name content exactly as Git does", async (t) => {
  const root = await temp(t);
  await addAssets(root);
  await write(root, "README.md", "hello");
  await run(root, "init", "--initial-branch=main");
  await run(root, "add", ".");
  await run(root, "commit", "-m", "x");
  const listing = await run(root, "ls-tree", "-r", "-t", "HEAD");
  const expected = listing.split("\n").map((line) => {
    const [meta, path] = line.split("\t");
    const [mode, , hash] = meta!.split(" ");
    return { path: path!, mode: mode!, hash: hash! };
  });
  const actual = (await folderSnapshot(root)).entries;
  const key = (e: { path: string }) => e.path;
  expect(
    [...actual].sort((a, b) => key(a).localeCompare(key(b))),
  ).toStrictEqual(expected.sort((a, b) => key(a).localeCompare(key(b))));
});

test("stable IDs are valid UUIDv4 and depend on every part", () => {
  const id = stableId("workspace", "skill", "org", "a");
  expect(id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(id).toBe(stableId("workspace", "skill", "org", "a"));
  expect(id).not.toBe(stableId("workspace", "skill", "org", "b"));
});

test("an admin creates a workspace and a member installs every asset kind", async (t) => {
  const { root, url, output } = await teamRepo(t);
  expect(output).toMatch(/Keeping the repo safe is the job/);
  const member = join(root, "member");
  await setupGit(url, member);
  const settings = await readSettings(member);
  assert(settings?.gitWorkspace);
  expect(settings.gitWorkspace.branch).toBe("main");
  expect(settings.connection).toBe(undefined);
  expect(await installed(member, "skills/code-review/SKILL.md")).toMatch(
    /code-review/,
  );
  expect(await installed(member, "skills/code-review/references/a.txt")).toBe(
    "supporting",
  );
  const hookScript = join(
    member,
    ".barndog/installed/hooks/org-org-audit/audit.sh",
  );
  expect((await lstat(hookScript)).mode & 0o100).toBeTruthy();
  expect(await readFile(join(member, ".claude.json"), "utf8")).toMatch(
    /DOCS_TOKEN/,
  );
  // Team assets stay out because this member chose only the organization.
  await expect(installed(member, "skills/lint/SKILL.md")).rejects.toThrow();
  const hooks = (await claudeSettings(member)).hooks.SessionStart;
  expect(
    hooks.some((h: { hooks: { command: string }[] }) =>
      h.hooks[0]!.command.includes("git-workspace/startup.js"),
    ),
  ).toBeTruthy();
  const docs = await knowledgeList(true, member);
  expect(docs.map((d) => d.name)).toStrictEqual(["architecture"]);
  expect(
    (await knowledgeGet("architecture", member)).version.content.markdown,
  ).toMatch(/# Architecture/);
  const status = await inventory(member);
  expect(status.server).toBe(url);
  expect(status.offline).toBe(null);
  expect(
    (await searchCatalog("skill", member)).map((a) => a.name),
  ).toStrictEqual(["code-review", "lint"]);
});

test("merged changes reach members, sets work, and removals apply", async (t) => {
  const { root, url, clone } = await teamRepo(t);
  const member = join(root, "member");
  await setupGit(url, member);
  await write(
    clone,
    "org/skills/code-review/SKILL.md",
    skill("code-review", "New."),
  );
  await commit(clone, "Update");
  const events = await synchronize(undefined, member);
  expect(events.some((e) => e.type === "updated")).toBeTruthy();
  expect(await installed(member, "skills/code-review/SKILL.md")).toMatch(
    /New\./,
  );
  await installSet({ origin: "team/web", mode: "all" }, member);
  expect(await installed(member, "skills/lint/SKILL.md")).toMatch(/lint/);
  await rm(join(clone, "org/skills/code-review"), { recursive: true });
  await commit(clone, "Remove");
  await synchronize(undefined, member);
  await expect(
    installed(member, "skills/code-review/SKILL.md"),
  ).rejects.toThrow();
});

test("an invalid asset whose installed folder is gone doesn't block sync", async (t) => {
  const { root, url, clone } = await teamRepo(t);
  const member = join(root, "member");
  await setupGit(url, member);
  await write(clone, "org/skills/code-review/SKILL.md", "not valid");
  await commit(clone, "Break");
  await rm(join(member, ".barndog/installed/skills/code-review"), {
    recursive: true,
  });
  await synchronize(undefined, member);
  await synchronize(undefined, member);
  await expect(
    lstat(join(member, ".barndog/pending-sync.json")),
  ).rejects.toThrow();
  await expect(
    lstat(join(member, ".claude/skills/code-review")),
  ).rejects.toThrow();
  await write(clone, "org/skills/code-review/SKILL.md", skill("code-review"));
  await commit(clone, "Fix");
  await synchronize(undefined, member);
  expect(await installed(member, "skills/code-review/SKILL.md")).toMatch(
    /Do the thing/,
  );
});

for (const newcomer of ["org", "teams/web"]) {
  test(`an invalid Skill keeps its automatic name from a newcomer in ${newcomer}`, async (t) => {
    const { root, url, clone } = await teamRepo(t);
    const member = join(root, "member");
    await setupGit(url, member, undefined, everyScope);
    const settings = await readSettings(member);
    assert(settings);
    const state = JSON.parse(
      await readFile(join(member, ".barndog/state.json"), "utf8"),
    );
    const id = state.links.find((entry: { target: string }) =>
      entry.target.endsWith("/code-review"),
    ).id;
    await saveSettings(
      { ...settings, localNames: { [id]: "org-org-code-review" } },
      member,
    );
    await write(
      clone,
      "org/skills/code-review/SKILL.md",
      skill("code-review", "Renamed copy."),
    );
    await commit(clone, "Update");
    await write(
      clone,
      "teams/web/skills/code-review/SKILL.md",
      skill("code-review", "Holds the plain name."),
    );
    await commit(clone, "Clash");
    await synchronize(undefined, member);
    await write(clone, "org/skills/code-review/SKILL.md", "not valid");
    await rm(join(clone, "teams/web/skills/code-review"), { recursive: true });
    await write(
      clone,
      `${newcomer}/skills/org-org-code-review/SKILL.md`,
      skill("org-org-code-review", "Newcomer."),
    );
    await commit(clone, "Break and add");
    const events = await synchronize(undefined, member);
    expect(
      events.some(
        (e) => e.type === "clash" && e.name === "org-org-code-review",
      ),
    ).toBeTruthy();
    await synchronize(undefined, member);
    expect(
      await installed(member, "skills/org-org-code-review/SKILL.md"),
    ).toMatch(/Renamed copy/);
  });
}

for (const [broken, added] of [
  ["teams/web/skills/lint", "org/skills/lint"],
  ["org/skills/lint", "teams/web/skills/lint"],
] as const) {
  test(`an invalid installed Skill keeps its name from a valid newcomer: ${broken}`, async (t) => {
    const { root, url, clone } = await teamRepo(t);
    await rm(join(clone, "teams/web/skills/lint"), { recursive: true });
    await write(clone, `${broken}/SKILL.md`, skill("lint"));
    // The team keeps another Skill, so the member still subscribes to it.
    await write(clone, "teams/web/skills/other/SKILL.md", skill("other"));
    await commit(clone, "Place");
    const member = join(root, "member");
    await setupGit(url, member, undefined, everyScope);
    await write(clone, `${broken}/SKILL.md`, "not valid");
    await write(clone, `${added}/SKILL.md`, skill("lint", "Newcomer."));
    await commit(clone, "Break and add");
    const events = await synchronize(undefined, member);
    expect(
      events.some((e) => e.type === "clash" && e.name === "lint"),
    ).toBeTruthy();
    await synchronize(undefined, member);
    expect(await installed(member, "skills/lint/SKILL.md")).toMatch(/Do the/);
  });
}

const hookNamed = (name: string, script: string) =>
  hookYaml
    .replace("name: audit", `name: ${name}`)
    .replaceAll("audit.sh", script);

test("Hooks whose prefixes read the same get separate folders", async (t) => {
  const { root, url, clone } = await teamRepo(t);
  await write(clone, "teams/a/hooks/b-c/hook.yaml", hookNamed("b-c", "one.sh"));
  await write(clone, "teams/a/hooks/b-c/one.sh", "#!/bin/sh\necho one\n");
  await write(clone, "teams/a-b/hooks/c/hook.yaml", hookNamed("c", "two.sh"));
  await write(clone, "teams/a-b/hooks/c/two.sh", "#!/bin/sh\necho two\n");
  await commit(clone, "Hooks");
  const member = join(root, "member");
  await setupGit(url, member, undefined, everyScope);
  const folders = (await readdir(join(member, ".barndog/installed/hooks")))
    .filter((name) => name.startsWith("team-a-b-c"))
    .sort();
  expect(folders.length).toBe(2);
  expect(
    folders.every((name) => /^team-a-b-c-[0-9a-z]{8}$/.test(name)),
  ).toBeTruthy();
  const scripts = await Promise.all(
    folders.map((name) =>
      readdir(join(member, ".barndog/installed/hooks", name)),
    ),
  );
  expect(
    scripts
      .flat()
      .filter((name) => name.endsWith(".sh"))
      .sort(),
  ).toStrictEqual(["one.sh", "two.sh"]);

  // A machine that already recorded both at one path recovers on its next sync.
  const statePath = join(member, ".barndog/state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const shared = join(member, ".barndog/installed/hooks/team-a-b-c");
  const hooks = state.installed.filter((entry: { path: string }) =>
    entry.path.includes("team-a-b-c-"),
  );
  await cp(hooks[0].path, shared, { recursive: true });
  for (const entry of hooks) entry.path = shared;
  await writeFile(statePath, JSON.stringify(state));
  await synchronize(undefined, member);
  const repaired = JSON.parse(
    await readFile(statePath, "utf8"),
  ).installed.filter((entry: { path: string }) =>
    entry.path.includes("team-a-b-c"),
  ) as { path: string }[];
  expect(new Set(repaired.map((entry) => entry.path)).size).toBe(2);
  expect(repaired.some((entry) => entry.path === shared)).toBeTruthy();
  const delivered = await Promise.all(
    repaired.map((entry) => readdir(entry.path)),
  );
  expect(
    delivered
      .flat()
      .filter((name) => name.endsWith(".sh"))
      .sort(),
  ).toStrictEqual(["one.sh", "two.sh"]);
});

test("an old repeated link in state is repaired, keeping the copy on disk", async (t) => {
  const { root, url, clone } = await teamRepo(t);
  const member = join(root, "member");
  await setupGit(url, member);
  const statePath = join(member, ".barndog/state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const link = state.links.find((entry: { target: string }) =>
    entry.target.endsWith("/code-review"),
  );
  const tree = state.installed.find(
    (entry: { path: string }) => entry.path === link.source,
  );
  const stale = randomUUID();
  state.links.unshift({ ...link, id: stale });
  state.installed.unshift({ ...tree, id: stale, fingerprint: "stale" });
  await writeFile(statePath, JSON.stringify(state));
  await write(clone, "org/skills/code-review/SKILL.md", "not valid");
  await commit(clone, "Break");
  await synchronize(undefined, member);
  await synchronize(undefined, member);
  const after = JSON.parse(await readFile(statePath, "utf8"));
  expect(
    after.links
      .filter((entry: { target: string }) =>
        entry.target.endsWith("/code-review"),
      )
      .map((entry: { id: string }) => entry.id),
  ).toStrictEqual([link.id]);
  expect(await installed(member, "skills/code-review/SKILL.md")).toMatch(
    /Do the thing/,
  );
});

test("a repeated link with another source keeps the one the target points to", async (t) => {
  const { root, url } = await teamRepo(t);
  const member = join(root, "member");
  await setupGit(url, member);
  const statePath = join(member, ".barndog/state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const link = state.links.find((entry: { target: string }) =>
    entry.target.endsWith("/code-review"),
  );
  state.links.unshift({ ...link, id: randomUUID(), source: join(root, "ext") });
  await writeFile(statePath, JSON.stringify(state));
  await inventory(member);
  await synchronize(undefined, member);
  const after = JSON.parse(await readFile(statePath, "utf8"));
  expect(
    after.links
      .filter((entry: { target: string }) =>
        entry.target.endsWith("/code-review"),
      )
      .map((entry: { id: string }) => entry.id),
  ).toStrictEqual([link.id]);
});

test("an invalid Skill renamed since it broke still holds its installed name", async (t) => {
  const { root, url, clone } = await teamRepo(t);
  const member = join(root, "member");
  await setupGit(url, member, undefined, everyScope);
  const state = JSON.parse(
    await readFile(join(member, ".barndog/state.json"), "utf8"),
  );
  const id = state.links.find((entry: { target: string }) =>
    entry.target.endsWith("/code-review"),
  ).id;
  await write(clone, "org/skills/code-review/SKILL.md", "not valid");
  await write(
    clone,
    "teams/web/skills/code-review/SKILL.md",
    skill("code-review", "Newcomer."),
  );
  await commit(clone, "Break and add");
  const settings = await readSettings(member);
  assert(settings);
  await saveSettings({ ...settings, localNames: { [id]: "renamed" } }, member);
  const events = await synchronize(undefined, member);
  expect(
    events.some((e) => e.type === "clash" && e.name === "code-review"),
  ).toBeTruthy();
  await synchronize(undefined, member);
  expect(await installed(member, "skills/code-review/SKILL.md")).toMatch(
    /Do the thing/,
  );
  const saved = await readSettings(member);
  assert(saved);
  expect(saved.localNames?.[id]).toBe("renamed");
  // Its installed name isn't free just because a rename is waiting on a fix.
  await expect(
    renameAsset(
      { kind: "skill", name: "lint", origin: "team/web", as: "code-review" },
      member,
    ),
  ).rejects.toThrow(/code-review is already used by/);
});

test("sync names assets it skips because of their name", async (t) => {
  const home = await temp(t);
  const folder = await setupLocal(home);
  await write(folder, "org/mcp/My_Server.yaml", mcpYaml);
  const events = await synchronize(undefined, home);
  expect(
    events.some(
      (event) =>
        event.type === "notice" &&
        event.message.includes("org/mcp/My_Server.yaml was skipped"),
    ),
  ).toBeTruthy();
});

test("imports refuse unsafe names and occupied folders", async (t) => {
  const home = await temp(t);
  const folder = await setupLocal(home);
  const victim = join(folder, "../victim");
  await write(victim, "keep.txt", "keep");
  const add = (name: string) =>
    saveImported(
      {
        kind: "skill",
        name,
        entries: [
          {
            path: "SKILL.md",
            data: Buffer.from(skill(name)),
            executable: false,
          },
        ],
        mode: "fork",
        remote: {} as never,
        root: "",
      },
      home,
    );
  await expect(add("../../../victim")).rejects.toThrow(
    /can't be used as a name/,
  );
  await expect(add("Bad_Name")).rejects.toThrow(/can't be used as a name/);
  expect(await readFile(join(victim, "keep.txt"), "utf8")).toBe("keep");
  await write(folder, "org/skills/occupied/notes.md", "mine");
  await expect(add("occupied")).rejects.toThrow(/already exists/);
  expect(
    await readFile(join(folder, "org/skills/occupied/notes.md"), "utf8"),
  ).toBe("mine");
  await mkdir(join(folder, "org/skills/empty"), { recursive: true });
  await add("empty");
  expect(
    await readFile(join(folder, "org/skills/empty/SKILL.md"), "utf8"),
  ).toMatch(/name: empty/);
});

test("MCP names are checked before anything changes", async (t) => {
  const home = await temp(t);
  const folder = await setupLocal(home);
  const native = JSON.stringify({
    mcpServers: { My_Server: { command: "run" } },
  });
  await writeFile(join(home, ".claude.json"), native);
  for (const name of ["My_Server", "../escape"])
    await expect(
      addMcpServers(
        [{ name, definition: {}, notes: [] }] as never,
        { replace: true },
        home,
      ),
    ).rejects.toThrow(/can't be used as an MCP name/);
  expect(await readFile(join(home, ".claude.json"), "utf8")).toBe(native);
  await expect(lstat(join(folder, "org/escape.yaml"))).rejects.toThrow();
});

test("a Cloud machine with a local folder keeps Cloud collaboration", async (t) => {
  const home = await temp(t);
  await setupLocal(home);
  const settings = await readSettings(home);
  assert(settings);
  await saveSettings(
    {
      ...settings,
      connection: {
        server: "https://barndog.example.com",
        organizationId: randomUUID(),
        developerId: randomUUID(),
      },
    },
    home,
  );
  expect(await workingStatus(home, home)).toStrictEqual({
    mode: "environment",
  });
  await expect(listChanges({}, home)).rejects.toSatisfy(
    (error: Error) => !/no review step/.test(error.message),
  );
  await expect(
    pushWorkingCopy({ origin: "local" }, home, home),
  ).rejects.toThrow(/no review step/);
});

test("an invalid asset is reported and the installed version stays", async (t) => {
  const { root, url, clone } = await teamRepo(t);
  const member = join(root, "member");
  await setupGit(url, member);
  await write(clone, "org/skills/code-review/SKILL.md", "not valid");
  await write(clone, "org/mcp/docs.yaml", "transport: nope\n");
  await commit(clone, "Break");
  const events = await synchronize(undefined, member);
  expect(
    events.flatMap((e) => (e.type === "invalid" ? [e.name] : [])).sort(),
  ).toStrictEqual(["code-review", "docs"]);
  expect(await installed(member, "skills/code-review/SKILL.md")).toMatch(
    /Do the thing/,
  );
  expect(await readFile(join(member, ".claude.json"), "utf8")).toMatch(
    /DOCS_TOKEN/,
  );
  expect(
    (await doctor(member)).some((check) => check.name === "Invalid asset"),
  ).toBeTruthy();
});

test("the session-start entry syncs in a detached process", async (t) => {
  const { root, url, clone } = await teamRepo(t);
  const member = join(root, "member");
  await setupGit(url, member);
  const hooks = (await claudeSettings(member)).hooks.SessionStart as {
    hooks: { command: string }[];
  }[];
  const command = hooks
    .find((h) => h.hooks[0]!.command.includes("git-workspace/startup.js"))!
    .hooks[0]!.command // Sync registers the hook next to the running code; run the built copy.
    .replaceAll(sourceRoot, builtRoot);
  await write(
    clone,
    "org/skills/code-review/SKILL.md",
    skill("code-review", "Background."),
  );
  await commit(clone, "Update");
  // A fresh fetch time would make the automatic run skip the host, as designed.
  const state = join(
    member,
    ".barndog/git",
    `${await gitWorkspaceId(member)}.json`,
  );
  const saved = JSON.parse(await readFile(state, "utf8"));
  await writeFile(
    state,
    JSON.stringify({ ...saved, fetchedAt: "2020-01-01T00:00:00.000Z" }),
  );
  await execute("/bin/sh", ["-c", command]);
  for (let attempt = 0; attempt < 100; attempt++) {
    const text = await installed(member, "skills/code-review/SKILL.md");
    if (text.includes("Background.")) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect.unreachable("The background sync did not update the installed Skill");
});

test("repo status answers from barndog.yaml", async (t) => {
  const { root, url, clone } = await teamRepo(t);
  const config = await readFile(join(clone, "barndog.yaml"), "utf8");
  await writeFile(
    join(clone, "barndog.yaml"),
    config
      .replace("teams: {}", "teams:\n  web:\n    name: Web")
      .replace(
        "repositories: {}",
        "repositories:\n  app:\n    gitRemote: github.com/acme/app\n    team: web",
      ),
  );
  await commit(clone, "Map");
  const member = join(root, "member");
  await setupGit(url, member);
  const project = join(root, "project");
  await mkdir(project);
  await run(project, "init");
  await run(project, "remote", "add", "origin", "git@github.com:acme/app.git");
  const previous = process.cwd();
  process.chdir(project);
  t.onTestFinished(async () => process.chdir(previous));
  const status = await repoStatus(member);
  expect(status.repository?.slug).toBe("app");
  expect(status.team?.name).toBe("Web");
});

test("a force push is followed like any other update", async (t) => {
  const { root, url, clone } = await teamRepo(t);
  const member = join(root, "member");
  await setupGit(url, member);
  await write(
    clone,
    "org/skills/code-review/SKILL.md",
    skill("code-review", "Rewritten."),
  );
  await run(clone, "add", ".");
  await run(clone, "commit", "--amend", "-m", "Rewritten");
  await run(clone, "push", "--force", "origin", "main");
  await synchronize(undefined, member);
  expect(await installed(member, "skills/code-review/SKILL.md")).toMatch(
    /Rewritten\./,
  );
});

test("setup explains a repo it can't read and only clones when asked", async (t) => {
  const root = await temp(t);
  const missing = join(root, "missing.git");
  const lines: string[] = [];
  const attempt = (confirmClone: () => Promise<boolean>) =>
    runSetup({
      home: join(root, "home"),
      repo: missing,
      restart: true,
      interactive: true,
      detected: [],
      write: (line) => lines.push(line),
      confirmClone,
      choose: async () => [],
    });
  await expect(attempt(async () => false)).rejects.toSatisfy(
    (error: CliError) => error.hint === `git clone ${missing}`,
  );
  expect(lines.join("\n")).toMatch(/able to clone this repo/);
  await expect(attempt(async () => true)).rejects.toThrow(/Git couldn't clone/);
  expect(await readSettings(join(root, "home"))).toBe(null);
});

test("a terminal clone connects the workspace and an empty repo returns null", async (t) => {
  const { root, url } = await teamRepo(t);
  const home = join(root, "cloned");
  const workspace = await cloneGitWorkspace(url, home);
  expect(workspace?.branch).toBe("main");
  await saveSettings(
    {
      harnesses: ["claude"],
      gitWorkspace: workspace!,
    },
    home,
  );
  await installSet({ origin: "org", mode: "all" }, home);
  expect(await installed(home, "skills/code-review/SKILL.md")).toMatch(/Do/);
  const empty = join(root, "empty.git");
  await run(root, "init", "--bare", "--initial-branch=main", empty);
  expect(await cloneGitWorkspace(empty, join(root, "other"))).toBe(null);
});

test("starting over offers every source without contacting the saved server", async (t) => {
  const root = await temp(t);
  const home = join(root, "home");
  await saveSettings(
    {
      harnesses: ["claude"],
      // Nothing listens here, so any request would fail setup.
      connection: {
        server: "http://127.0.0.1:9",
        organizationId: randomUUID(),
        developerId: randomUUID(),
      },
    },
    home,
  );
  let offered: unknown;
  await runSetup({
    home,
    restart: true,
    interactive: true,
    detected: [],
    write: () => {},
    confirmRestart: async () => true,
    chooseConnection: async (current) => {
      offered = current;
      return { kind: "local" };
    },
    confirmApply: async () => true,
    choose: async () => ["claude"],
  });
  expect(offered).toStrictEqual({
    kind: "cloud",
    server: "http://127.0.0.1:9",
  });
  const saved = await readSettings(home);
  assert(saved?.localWorkspace);
  expect(saved.connection).toBe(undefined);
});

test("--local and --repo replace a connected source once confirmed", async (t) => {
  const { root, url } = await teamRepo(t);
  const home = join(root, "connected");
  await saveSettings(
    {
      harnesses: ["claude"],
      connection: {
        server: "http://127.0.0.1:9",
        organizationId: randomUUID(),
        developerId: randomUUID(),
      },
    },
    home,
  );
  await setupGit(url, home);
  const saved = await readSettings(home);
  assert(saved?.gitWorkspace);
  expect(saved.connection).toBe(undefined);
});

test("choosing cloud clears a repo workspace and its choices", async (t) => {
  const { root, url } = await teamRepo(t);
  const home = join(root, "member");
  await setupGit(url, home);
  const org = randomUUID();
  const dev = randomUUID();
  const context = {
    organization: { id: org, slug: "acme", name: "Acme" },
    developer: { id: dev, slug: "a", name: "A", role: "organization_admin" },
  };
  const server = createServer((_, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(context));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.onTestFinished(async () => void server.close());
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await updateCredentials(home, (file) => {
    file.servers[origin] = {
      token: "a".repeat(43),
      expiresAt: new Date(Date.now() + 1e7).toISOString(),
      context,
    } as never;
  });
  await initialize({
    home,
    server: origin,
    detected: [],
    choose: async () => [],
  });
  const saved = await readSettings(home);
  assert(saved?.connection);
  expect(saved.gitWorkspace).toBe(undefined);
  expect(saved.environment).toBe(undefined);
});

test("--repo accepts a clone on disk and uses the remote it came from", async (t) => {
  const { root, url, clone } = await teamRepo(t);
  const member = join(root, "member");
  await setupGit(clone, member);
  const settings = await readSettings(member);
  expect(settings?.gitWorkspace?.url).toBe(url);
});

test("sync uses the last fetch when the host is unreachable", async (t) => {
  const { root, url } = await teamRepo(t);
  const member = join(root, "member");
  await setupGit(url, member);
  await rm(url, { recursive: true, force: true });
  const events = await synchronize(undefined, member);
  expect(
    events.some(
      (e) => e.type === "notice" && e.message.includes("Can't reach"),
    ),
  ).toBeTruthy();
  expect(await installed(member, "skills/code-review/SKILL.md")).toMatch(/Do/);
  expect(
    (await doctor(member)).find((c) => c.name === "Git access")?.status,
  ).toBe("fail");
});

test("automatic sync reuses a recent fetch", async (t) => {
  const { root, url, clone } = await teamRepo(t);
  const member = join(root, "member");
  await setupGit(url, member);
  await write(
    clone,
    "org/skills/code-review/SKILL.md",
    skill("code-review", "Later."),
  );
  await commit(clone, "Update");
  await synchronize(undefined, member, undefined, {
    refresh: "auto",
    prompt: false,
  });
  expect(await installed(member, "skills/code-review/SKILL.md")).not.toMatch(
    /Later/,
  );
  await synchronize(undefined, member);
  expect(await installed(member, "skills/code-review/SKILL.md")).toMatch(
    /Later/,
  );
});

test("working copies push review branches and merge upstream edits", async (t) => {
  const { root, url, clone } = await teamRepo(t);
  const member = join(root, "member");
  await setupGit(url, member);
  const options = { name: "code-review", origin: "org" };
  await pullPackage(options, root, member);
  const work = join(root, "code-review");
  await write(work, "SKILL.md", skill("code-review", "Member edit."));
  await write(work, "notes.txt", "added");
  const status = (await workingStatus(work, member)) as {
    changes: unknown[];
  };
  expect(status.changes.length).toBe(2);
  expect(renderCollaboration(status).join("\n")).toMatch(/Base: [0-9a-f]{7}/);
  const pushed = (await pushWorkingCopy(
    { title: "Clarify" },
    work,
    member,
  )) as {
    branch: string;
    commit: string;
  };
  expect(pushed.branch).toMatch(/^barndog\/org-code-review-[0-9a-f]{6}$/);
  expect(renderCollaboration(pushed).join("\n")).toMatch(/Open a pull request/);
  // Nothing lands on the default branch until the host merges it.
  await run(clone, "fetch", "origin");
  expect(
    await run(clone, "show", "origin/main:org/skills/code-review/SKILL.md"),
  ).not.toMatch(/Member edit/);
  expect(
    await run(
      clone,
      "show",
      `origin/${pushed.branch}:org/skills/code-review/notes.txt`,
    ),
  ).toBe("added");
  expect(
    await run(clone, "log", "-1", "--format=%s", `origin/${pushed.branch}`),
  ).toBe("Clarify");
  expect(await pushWorkingCopy({}, work, member)).toStrictEqual({
    unchanged: true,
  });
  await write(work, "notes.txt", "added twice");
  const again = (await pushWorkingCopy({}, work, member)) as {
    branch: string;
  };
  expect(again.branch).toBe(pushed.branch);
  await run(clone, "fetch", "origin");
  expect(
    await run(
      clone,
      "rev-list",
      "--count",
      `origin/main..origin/${pushed.branch}`,
    ),
  ).toBe("2");
  // The host merges it, and pull closes the review.
  await run(clone, "merge", "--no-edit", `origin/${pushed.branch}`);
  await run(clone, "push", "origin", "main");
  const pulled = (await updateWorkingCopy(work, member)) as {
    conflicts: string[];
  };
  expect(pulled.conflicts).toStrictEqual([]);
  const after = (await workingStatus(work, member)) as {
    review: unknown;
    changes: unknown[];
  };
  expect(after.review).toBe(null);
  expect(after.changes).toStrictEqual([]);
});

test("pull merges upstream, conflicts block push, and resolve clears them", async (t) => {
  const { root, url, clone } = await teamRepo(t);
  const member = join(root, "member");
  await setupGit(url, member);
  await pullPackage({ name: "code-review", origin: "org" }, root, member);
  const work = join(root, "code-review");
  await write(work, "SKILL.md", skill("code-review", "Local."));
  await write(
    clone,
    "org/skills/code-review/SKILL.md",
    skill("code-review", "Upstream."),
  );
  await commit(clone, "Upstream");
  const result = (await updateWorkingCopy(work, member)) as {
    conflicts: string[];
  };
  expect(result.conflicts).toStrictEqual(["SKILL.md"]);
  await expect(pushWorkingCopy({}, work, member)).rejects.toThrow(
    /Resolve conflicts/,
  );
  await expect(resolveFile("SKILL.md", work, member)).rejects.toThrow(
    /conflict markers/,
  );
  await write(work, "SKILL.md", skill("code-review", "Merged."));
  await resolveFile("SKILL.md", work, member);
  const pushed = (await pushWorkingCopy({}, work, member)) as {
    branch: string;
  };
  expect(pushed.branch).toBeTruthy();
});

test("push --publish goes straight to the default branch only when asked", async (t) => {
  const { root, url, clone } = await teamRepo(t);
  const member = join(root, "member");
  await setupGit(url, member);
  await pullPackage({ name: "code-review", origin: "org" }, root, member);
  const work = join(root, "code-review");
  await write(work, "SKILL.md", skill("code-review", "Direct."));
  const result = (await pushWorkingCopy({ publish: true }, work, member)) as {
    published: boolean;
    branch: string;
  };
  expect(result.published).toBe(true);
  expect(result.branch).toBe("main");
  await run(clone, "pull", "origin", "main");
  expect(
    await readFile(join(clone, "org/skills/code-review/SKILL.md"), "utf8"),
  ).toMatch(/Direct/);
  // A stale base must not overwrite someone else's merge.
  await write(
    clone,
    "org/skills/code-review/SKILL.md",
    skill("code-review", "Other."),
  );
  await commit(clone, "Other");
  await write(work, "SKILL.md", skill("code-review", "Stale."));
  await expect(
    pushWorkingCopy({ publish: true }, work, member),
  ).rejects.toSatisfy((error: CliError) => error.hint === "barndog pull");
});

test("create starts a new asset in a new team scope and history is readable", async (t) => {
  const { root, url, clone } = await teamRepo(t);
  const member = join(root, "member");
  await setupGit(url, member);
  await createPackage(
    { name: "fresh", origin: "team/mobile", kind: "hook" },
    root,
    member,
  );
  const pushed = (await pushWorkingCopy({}, join(root, "fresh"), member)) as {
    branch: string;
  };
  expect(pushed.branch).toMatch(/^barndog\/team-mobile-fresh-/);
  await run(clone, "fetch", "origin");
  expect(
    await run(
      clone,
      "show",
      `origin/${pushed.branch}:teams/mobile/hooks/fresh/hook.yaml`,
    ),
  ).toMatch(/name: fresh/);
  await write(
    clone,
    "org/skills/code-review/SKILL.md",
    skill("code-review", "V2."),
  );
  await commit(clone, "Second");
  const options = { name: "code-review", origin: "org" };
  const versions = (await packageVersions(options, member)) as {
    number: number;
    description: string;
  }[];
  expect(versions.map((v) => [v.number, v.description])).toStrictEqual([
    [1, "Add assets"],
    [2, "Second"],
  ]);
  const diff = (await diffVersions({ ...options, from: 1, to: 2 }, member)) as {
    patch: string;
  }[];
  expect(diff[0]!.patch).toMatch(/V2/);
});

test("review commands point to the Git host and cloud-only commands explain why", async (t) => {
  const { root, url } = await teamRepo(t);
  const member = join(root, "member");
  await setupGit(url, member);
  await expect(listChanges({}, member)).rejects.toThrow(
    /pull requests on your Git host/,
  );
  await expect(developers(undefined, member)).rejects.toSatisfy(
    (error: CliError) =>
      /Cloud Workspace/.test(error.message) &&
      error.hint === "barndog migrate --to <server>",
  );
});

test("a repository that isn't a workspace is refused without changes", async (t) => {
  const root = await temp(t);
  const url = join(root, "other.git");
  await run(root, "init", "--bare", "--initial-branch=main", url);
  const clone = join(root, "clone");
  await run(root, "clone", url, clone);
  await write(clone, "README.md", "x");
  await commit(clone, "x");
  await expect(setupGit(url, join(root, "home"))).rejects.toThrow(
    /isn't a BarnDog workspace/,
  );
});

test("local mode delivers every kind from a folder and needs no Git", async (t) => {
  const root = await temp(t);
  const home = join(root, "home");
  await runSetup({
    home,
    local: true,
    restart: true,
    interactive: true,
    detected: [],
    write: () => {},
    confirmApply: async () => true,
    choose: async () => ["claude"],
  });
  const settings = await readSettings(home);
  assert(settings?.localWorkspace);
  const folder = settings.localWorkspace.path;
  await addAssets(folder);
  await synchronize(undefined, home);
  expect(await installed(home, "skills/code-review/SKILL.md")).toMatch(
    /code-review/,
  );
  expect(await readFile(join(home, ".claude.json"), "utf8")).toMatch(
    /DOCS_TOKEN/,
  );
  expect((await knowledgeList(false, home)).map((d) => d.name)).toStrictEqual([
    "architecture",
  ]);
  await write(
    folder,
    "org/skills/code-review/SKILL.md",
    skill("code-review", "Edited."),
  );
  await synchronize(undefined, home);
  expect(await installed(home, "skills/code-review/SKILL.md")).toMatch(
    /Edited/,
  );
  await expect(
    pullPackage({ name: "code-review", origin: "org" }, root, home),
  ).rejects.toThrow(/Edit them directly/);
});

test("sync unlinks removed Skills and refuses to replace a link it doesn't own", async (t) => {
  const root = await temp(t);
  const home = join(root, "home");
  await runSetup({
    home,
    local: true,
    restart: true,
    interactive: true,
    detected: [],
    write: () => {},
    confirmApply: async () => true,
    choose: async () => ["claude"],
  });
  const settings = await readSettings(home);
  assert(settings?.localWorkspace);
  const folder = settings.localWorkspace.path;
  const link = join(home, ".claude/skills/example");
  await write(folder, "org/skills/example/SKILL.md", skill("example"));
  await synchronize(undefined, home);
  expect(await installed(home, "skills/example/SKILL.md")).toMatch(/example/);
  await rm(join(folder, "org/skills/example"), { recursive: true });
  await synchronize(undefined, home);
  await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
  await write(folder, "org/skills/example/SKILL.md", skill("example"));
  await symlink(root, link);
  await expect(synchronize(undefined, home)).rejects.toThrow(/unmanaged/);
  expect(await readlink(link)).toBe(root);
});

test("validate reports each problem for repo CI", async (t) => {
  const { clone } = await teamRepo(t);
  expect(await validateFolder(clone)).toStrictEqual({
    workspace: "team",
    assets: 4,
    knowledge: 1,
  });
  await write(clone, "org/skills/Bad_Name/SKILL.md", skill("bad"));
  await write(clone, "org/skills/mismatch/SKILL.md", skill("other"));
  await write(clone, "teams/web/knowledge/x.md", knowledgeMd);
  await expect(validateFolder(clone)).rejects.toSatisfy((error: Error) => {
    expect(error.message).toMatch(/3 problems/);
    expect(error.message).toMatch(/Bad_Name/);
    expect(error.message).toMatch(/must match the folder/);
    expect(error.message).toMatch(/organization-wide/);
    return true;
  });
});

test("settings allow only one workspace and repo URLs are checked", async (t) => {
  const home = await temp(t);
  const workspaceId = randomUUID();
  await expect(
    saveSettings(
      {
        harnesses: [],
        gitWorkspace: { url: "a", branch: "main", workspaceId },
        connection: {
          server: "http://127.0.0.1:9",
          organizationId: randomUUID(),
          developerId: randomUUID(),
        },
      },
      home,
    ),
  ).rejects.toThrow(/only one/);
  expect(() => checkRepositoryUrl("--upload-pack=evil")).toThrow(CliError);
  expect(() => checkRepositoryUrl("ext::sh -c evil")).toThrow(CliError);
  expect(() => checkRepositoryUrl("https://u:token@host/r.git")).toThrow(
    /password/,
  );
  expect(checkRepositoryUrl(" git@github.com:a/b.git ")).toBe(
    "git@github.com:a/b.git",
  );
});

test("the default server is set at build time and checked", async (t) => {
  const root = await temp(t);
  const script = new URL("../../scripts/finish-build.mjs", import.meta.url);
  const finish = (server?: string) =>
    execute(process.execPath, [script.pathname, root], {
      env: { ...process.env, BARNDOG_DEFAULT_SERVER: server ?? "" },
    });
  await write(root, "cli.js", "");
  await write(root, "config/build.js", "source default");
  await finish();
  expect(await readFile(join(root, "config/build.js"), "utf8")).toBe(
    "source default",
  );
  expect((await lstat(join(root, "cli.js"))).mode & 0o100).toBeTruthy();
  await finish("https://barndog.example.com/");
  expect(await readFile(join(root, "config/build.js"), "utf8")).toMatch(
    /"https:\/\/barndog\.example\.com"/,
  );
  await expect(finish("http://insecure.example.com")).rejects.toThrow(
    /must be an HTTPS origin/,
  );
  expect(defaultServer).toBe("https://barndog.dev");
});

test("compare links cover GitHub and GitLab only", () => {
  expect(
    compareUrl("git@github.com:acme/ai.git", "main", "barndog/org-a-1"),
  ).toBe("https://github.com/acme/ai/compare/main...barndog/org-a-1?expand=1");
  expect(compareUrl("https://gitlab.com/g/p.git", "main", "b") ?? "").toMatch(
    /^https:\/\/gitlab\.com\/g\/p\/-\/merge_requests\/new/,
  );
  expect(compareUrl("/srv/git/team.git", "main", "b")).toBe(null);
  expect(compareUrl("git@example.org:a/b.git", "main", "b")).toBe(null);
});

test("migrate previews, then moves assets and choices to cloud by scope and name", async (t) => {
  const root = await temp(t);
  const url = join(root, "team.git");
  await run(root, "init", "--bare", "--initial-branch=main", url);
  const home = join(root, "home");
  await setupGit(url, home);
  const clone = join(root, "clone");
  await run(root, "clone", url, clone);
  await write(clone, "org/mcp/docs.yaml", mcpYaml);
  await write(clone, "org/knowledge/architecture.md", knowledgeMd);
  await commit(clone, "Add");
  const org = randomUUID();
  const dev = randomUUID();
  const now = new Date().toISOString();
  const mcps: unknown[] = [];
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const url = new URL(request.url!, "http://localhost");
    requests.push(`${request.method} ${url.pathname}`);
    const send = (value: unknown) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/v1/context")
      return send({
        organization: { id: org, slug: "acme", name: "Acme" },
        developer: {
          id: dev,
          slug: "a",
          name: "A",
          role: "organization_admin",
        },
      });
    if (url.pathname === "/v1/scopes")
      return send([
        { type: "org", id: org, slug: "acme", name: "Acme", canPublish: true },
      ]);
    if (url.pathname === "/v1/environment/catalog")
      return send({
        assets: mcps.map((m) => {
          const mcp = m as {
            id: string;
            name: string;
            version: { id: string };
          };
          return {
            kind: "mcp",
            id: mcp.id,
            name: mcp.name,
            origin: { type: "org", id: org, slug: "acme" },
            publishedVersion: mcp.version.id,
          };
        }),
        distributions: [
          {
            scope: { type: "org", id: org },
            assets: mcps.map((m) => ({
              assetId: (m as { id: string }).id,
              mode: "recommended",
            })),
          },
        ],
      });
    if (url.pathname === "/v1/knowledge" && request.method === "GET")
      return send({ documents: [], nextCursor: null, total: 0 });
    if (url.pathname === "/v1/knowledge/publish") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const documentId = randomUUID();
      return send({
        id: documentId,
        organizationId: org,
        version: {
          id: randomUUID(),
          documentId,
          number: 1,
          content: body.content,
          publishedBy: dev,
          publishedAt: now,
        },
      });
    }
    if (url.pathname === "/v1/mcps" && request.method === "POST") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const id = randomUUID();
      const mcp = {
        id,
        organizationId: org,
        name: body.name,
        origin: { type: "org", id: org, slug: "acme" },
        createdBy: dev,
        createdAt: now,
        version: {
          id: randomUUID(),
          mcpId: id,
          number: 1,
          definition: body.definition,
          publishedBy: dev,
          publishedAt: now,
        },
        distributions: [],
      };
      mcps.push(mcp);
      return send(mcp);
    }
    const mcp = mcps.find(
      (m) => url.pathname === `/v1/mcps/${(m as { id: string }).id}`,
    );
    if (mcp) return send(mcp);
    response.writeHead(404);
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.onTestFinished(async () => void server.close());
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  await updateCredentials(home, (file) => {
    file.servers[origin] = {
      token: "a".repeat(43),
      expiresAt: new Date(Date.now() + 1e7).toISOString(),
      context: {
        organization: { id: org, slug: "acme", name: "Acme" },
        developer: {
          id: dev,
          slug: "a",
          name: "A",
          role: "organization_admin",
        },
      },
    };
    file.selectedServer = origin;
  });
  const preview = await migrate({ server: origin, dryRun: true }, home);
  expect(preview.rows.map((r) => [r.name, r.action])).toStrictEqual([
    ["docs", "publish"],
    ["architecture", "publish"],
  ]);
  expect(requests).not.toContain("POST /v1/mcps");
  const done = await migrate({ server: origin }, home);
  expect(done.migrated).toBe(true);
  const moved = await readSettings(home);
  assert(moved?.connection);
  expect(moved.gitWorkspace).toBe(undefined);
  expect(moved.environment?.subscriptions).toStrictEqual([
    { scope: { type: "org", id: org }, mode: "all", enabled: true },
  ]);
  expect(await readFile(join(home, ".claude.json"), "utf8")).toMatch(
    /DOCS_TOKEN/,
  );
});

test("commands the setup can't run explain why before doing anything", async (t) => {
  const root = await temp(t);
  const home = join(root, "home");
  const folder = await setupLocal(home);
  await expect(assertCommandAvailable(["login"], {}, home)).rejects.toSatisfy(
    (error: CliError) =>
      error.message.includes("signs in to a BarnDog Cloud Workspace") &&
      error.message.includes(folder) &&
      error.hint === "barndog init --server <url>",
  );
  for (const path of [
    ["whoami"],
    ["auth", "status"],
    ["github", "status"],
    ["changes", "list"],
    ["skills", "promote"],
    ["mcp", "create"],
  ])
    await expect(assertCommandAvailable(path, {}, home)).rejects.toThrow(
      /Cloud Workspace/,
    );
  for (const path of [["push"], ["skills", "pull"], ["mcp", "versions"]])
    await expect(assertCommandAvailable(path, {}, home)).rejects.toThrow(
      /Edit them directly/,
    );
  await expect(assertCommandAvailable(["logout"], {}, home)).rejects.toThrow(
    /aren't signed in/,
  );
  for (const path of [
    ["sync"],
    ["status"],
    ["skills", "list"],
    ["local", "list"],
    ["init"],
  ])
    await assertCommandAvailable(path, {}, home);
  let ran = false;
  const program = createProgram({
    guard: (path, options) => assertCommandAvailable(path, options, home),
    login: async () => {
      ran = true;
    },
    write: () => {},
  });
  await expect(program.parseAsync(["login"], { from: "user" })).rejects.toThrow(
    CliError,
  );
  expect(ran).toBe(false);
});

test("a Git setup sends reviews to the host and allows its own history", async (t) => {
  const { root, url } = await teamRepo(t);
  const home = join(root, "member");
  await setupGit(url, home);
  await expect(
    assertCommandAvailable(["changes", "list"], {}, home),
  ).rejects.toThrow(/pull requests on your Git host/);
  await expect(assertCommandAvailable(["login"], {}, home)).rejects.toThrow(
    /a Git repo/,
  );
  await assertCommandAvailable(["skills", "pull"], {}, home);
  await assertCommandAvailable(["push"], {}, home);
});

test("switching keeps local assets active next to the Git workspace", async (t) => {
  const { root, url, clone } = await teamRepo(t);
  const home = join(root, "dev");
  const folder = await setupLocal(home);
  await write(folder, "org/skills/mine/SKILL.md", skill("mine"));
  await write(folder, "org/knowledge/notes.md", knowledgeMd);
  await synchronize(undefined, home);
  await setupGit(url, home, "keep");
  const saved = await readSettings(home);
  expect(saved?.gitWorkspace && saved.localWorkspace).toBeTruthy();
  expect(await installed(home, "skills/mine/SKILL.md")).toMatch(/mine/);
  expect(await installed(home, "skills/code-review/SKILL.md")).toMatch(
    /code-review/,
  );
  expect(
    (await knowledgeList(false, home)).map((d) => d.name).sort(),
  ).toStrictEqual(["architecture", "notes"]);
  const items = (await inventory(home)).items;
  expect(items.find((i) => i.name === "mine")?.origin).toBe("local");
  expect(items.find((i) => i.name === "mine")?.via).toStrictEqual(["local"]);
  // New files in the folder follow, and a push to the repo still arrives.
  await write(folder, "org/skills/later/SKILL.md", skill("later"));
  await write(clone, "org/skills/from-team/SKILL.md", skill("from-team"));
  await commit(clone, "More");
  await synchronize(undefined, home);
  expect(await installed(home, "skills/later/SKILL.md")).toMatch(/later/);
  expect(await installed(home, "skills/from-team/SKILL.md")).toMatch(
    /from-team/,
  );
  await changeAsset(
    "disable",
    { kind: "skill", name: "mine", origin: "local" },
    home,
  );
  await expect(installed(home, "skills/mine/SKILL.md")).rejects.toThrow();
  expect(await readFile(join(folder, "org/skills/mine/SKILL.md"), "utf8")).toBe(
    skill("mine"),
  );
});

test("leaving local assets uninstalls them and never touches the folder", async (t) => {
  const { root, url } = await teamRepo(t);
  const home = join(root, "dev");
  const folder = await setupLocal(home);
  await write(folder, "org/skills/mine/SKILL.md", skill("mine"));
  await synchronize(undefined, home);
  await setupGit(url, home, "leave");
  const saved = await readSettings(home);
  expect(saved?.localWorkspace).toBe(undefined);
  await expect(installed(home, "skills/mine/SKILL.md")).rejects.toThrow();
  expect(await readFile(join(folder, "org/skills/mine/SKILL.md"), "utf8")).toBe(
    skill("mine"),
  );
});

test("moving into an empty repo commits directly", async (t) => {
  const root = await temp(t);
  const url = join(root, "team.git");
  await run(root, "init", "--bare", "--initial-branch=main", url);
  const home = join(root, "dev");
  const folder = await setupLocal(home);
  await addAssets(folder);
  await setupGit(url, home, "move");
  const clone = join(root, "clone");
  await run(root, "clone", url, clone);
  expect(
    await readFile(join(clone, "org/skills/code-review/SKILL.md"), "utf8"),
  ).toMatch(/code-review/);
  expect(
    await readFile(
      join(clone, "org/skills/code-review/references/a.txt"),
      "utf8",
    ),
  ).toBe("supporting");
  expect(await readFile(join(clone, "org/mcp/docs.yaml"), "utf8")).toMatch(
    /DOCS_TOKEN/,
  );
  expect(
    await readFile(join(clone, "org/knowledge/architecture.md"), "utf8"),
  ).toMatch(/# Architecture/);
  expect(
    (await lstat(join(clone, "org/hooks/audit/audit.sh"))).mode & 0o100,
  ).toBeTruthy();
  // The local copy stepped aside, so nothing clashes with what was just shared.
  const events = await synchronize(undefined, home, undefined, {
    prompt: false,
  });
  expect(events.some((e) => e.type === "clash")).toBeFalsy();
  expect(
    (await inventory(home)).items.filter((i) => i.name === "code-review")
      .length,
  ).toBe(1);
  expect(
    await readFile(join(folder, "org/skills/code-review/SKILL.md"), "utf8"),
  ).toBe(skill("code-review"));
});

test("moving into a used repo opens a review, lists clashes, and can move them later", async (t) => {
  const { root, url, clone } = await teamRepo(t);
  const home = join(root, "dev");
  const folder = await setupLocal(home);
  await write(
    folder,
    "org/skills/code-review/SKILL.md",
    skill("code-review", "Mine."),
  );
  await write(folder, "org/skills/mine/SKILL.md", skill("mine"));
  await setupGit(url, home, "keep");
  const result = await moveLocalAssets({}, home);
  expect(result.rows.map((r) => [r.name, r.status]).sort()).toStrictEqual([
    ["code-review", "clash"],
    ["mine", "moved"],
  ]);
  expect(result.branch!).toMatch(/^barndog\/local-move-/);
  expect(renderMove(result).join("\n")).toMatch(/--as <new-name>/);
  await run(clone, "fetch", "origin");
  await expect(
    run(clone, "show", `origin/${result.branch}:org/skills/mine/SKILL.md`),
  ).resolves.toBeTypeOf("string");
  await expect(
    run(clone, "show", "origin/main:org/skills/mine/SKILL.md"),
  ).rejects.toThrow();
  // Until it merges, the local copy keeps working.
  await synchronize(undefined, home, undefined, { prompt: false });
  expect(await installed(home, "skills/mine/SKILL.md")).toMatch(/mine/);
  await run(clone, "merge", "--no-edit", `origin/${result.branch}`);
  await run(clone, "push", "origin", "main");
  await synchronize(undefined, home, undefined, { prompt: false });
  expect(
    (await inventory(home)).items.filter((i) => i.name === "mine").length,
  ).toBe(1);
  const later = await moveLocalAssets(
    { names: ["code-review"], as: "my-review" },
    home,
  );
  expect(later.rows.map((r) => r.status)).toStrictEqual(["moved"]);
  await run(clone, "fetch", "origin");
  expect(
    await run(
      clone,
      "show",
      `origin/${later.branch}:org/skills/my-review/SKILL.md`,
    ),
  ).toMatch(/name: my-review/);
  await expect(moveLocalAssets({ names: ["nope"] }, home)).rejects.toThrow(
    /No local asset named nope/,
  );
  await expect(
    moveLocalAssets({ names: ["a", "b"], as: "x" }, home),
  ).rejects.toThrow(/exactly one/);
});

test("moving from a local-only machine asks for a destination first", async (t) => {
  const root = await temp(t);
  const home = join(root, "dev");
  await setupLocal(home);
  await expect(moveLocalAssets({}, home)).rejects.toSatisfy(
    (error: CliError) =>
      /nowhere to move/.test(error.message) &&
      Boolean(error.hint?.includes("--repo <url>")) &&
      Boolean(error.hint?.includes("--server <url>")),
  );
  await expect(
    migrate({ server: "http://127.0.0.1:9" }, home),
  ).rejects.toSatisfy(
    (error: CliError) => error.hint === "barndog init --server <url>",
  );
  const listed = await listLocalAssets(home);
  expect(listed.assets).toStrictEqual([]);
});

test("moving to cloud defaults to personal and keeps knowledge within permissions", async (t) => {
  const root = await temp(t);
  const home = join(root, "dev");
  const folder = await setupLocal(home);
  await write(folder, "org/mcp/docs.yaml", mcpYaml);
  await write(folder, "org/knowledge/notes.md", knowledgeMd);
  const org = randomUUID();
  const dev = randomUUID();
  const now = new Date().toISOString();
  const context = {
    organization: { id: org, slug: "acme", name: "Acme" },
    developer: { id: dev, slug: "a", name: "A", role: "developer" },
  };
  const origins: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const path = new URL(request.url!, "http://localhost").pathname;
    const send = (value: unknown) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(value));
    };
    if (path === "/v1/context") return send(context);
    if (path === "/v1/scopes")
      return send([
        { type: "org", id: org, slug: "acme", name: "Acme", canPublish: false },
        { type: "dev", id: dev, slug: "a", name: "A", canPublish: true },
      ]);
    if (path === "/v1/environment/catalog")
      return send({ assets: [], distributions: [] });
    if (path === "/v1/knowledge")
      return send({ documents: [], nextCursor: null, total: 0 });
    if (path === "/v1/mcps" && request.method === "POST") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      origins.push(body.origin);
      const id = randomUUID();
      return send({
        id,
        organizationId: org,
        name: body.name,
        origin: { type: "dev", id: dev, slug: "a" },
        createdBy: dev,
        createdAt: now,
        version: {
          id: randomUUID(),
          mcpId: id,
          number: 1,
          definition: body.definition,
          publishedBy: dev,
          publishedAt: now,
        },
        distributions: [],
      });
    }
    response.writeHead(404);
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.onTestFinished(async () => void server.close());
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await updateCredentials(home, (file) => {
    file.servers[origin] = {
      token: "a".repeat(43),
      expiresAt: new Date(Date.now() + 1e7).toISOString(),
      context,
    } as never;
    file.selectedServer = origin;
  });
  await runSetup({
    home,
    server: origin,
    restart: true,
    interactive: true,
    browser: false,
    detected: [],
    write: () => {},
    confirmRestart: async () => true,
    confirmApply: async () => true,
    choose: async () => ["claude"],
    chooseEnvironment: async (choices) => ({
      ...choices.previous,
      subscriptions: [],
    }),
    chooseLocalAssets: async () => "keep",
  });
  const saved = await readSettings(home);
  expect(saved?.connection && saved.localWorkspace).toBeTruthy();
  expect(await readFile(join(home, ".claude.json"), "utf8")).toMatch(
    /DOCS_TOKEN/,
  );
  const result = await moveLocalAssets({}, home);
  expect(origins).toStrictEqual([{ type: "dev", id: dev }]);
  expect(result.rows.map((r) => [r.name, r.status])).toStrictEqual([
    ["docs", "moved"],
    ["notes", "skipped"],
  ]);
  expect(result.rows[1]!.detail!).toMatch(/organization-wide/);
});

const noPrompts: AddPrompts = {
  chooseMany: async () => {
    throw new Error("Unexpected prompt");
  },
  chooseOne: async () => {
    throw new Error("Unexpected prompt");
  },
  text: async (_, fallback) => fallback ?? "",
  yes: async () => true,
  paste: async () => "",
};

const quiet = (
  home: string,
  prompts: Partial<AddPrompts> = {},
  interactive = false,
) => ({
  home,
  interactive,
  write: () => {},
  prompts: { ...noPrompts, ...prompts },
});

/** A public-style repo to add things from, as a real bare remote. */
async function sourceRepo(
  root: string,
  name: string,
  files: Record<string, string>,
) {
  const url = join(root, `${name}.git`);
  await run(root, "init", "--bare", "--initial-branch=main", url);
  const clone = join(root, `${name}-clone`);
  await run(root, "clone", url, clone);
  for (const [path, text] of Object.entries(files))
    await write(clone, path, text);
  await commit(clone, "Add");
  return { url, clone };
}

const localHome = async (t: T) => {
  const root = await temp(t);
  const home = join(root, "home");
  const folder = await setupLocal(home);
  return { root, home, folder };
};

test("a local-only setup says local, not org, while keeping asset IDs", async (t) => {
  const { root, home, folder } = await localHome(t);
  const { url } = await sourceRepo(root, "one", {
    "SKILL.md": "---\nname: solo\ndescription: One Skill\n---\nBody\n",
  });
  await addSkills(url, { updates: "fork" }, quiet(home));
  const [item] = (await inventory(home)).items.filter((i) => i.name === "solo");
  expect(item?.origin).toBe("local");
  expect(item?.via).toStrictEqual(["local"]);
  const shared = await loadWorkspace(await folderSnapshot(folder));
  expect(shared.assets.find((a) => a.name === "solo")?.id).toBe(item?.id);
  expect(originLabel(shared.scopes[0]!)).toBe("org");
});

test("a plain folder can be copied or moved into the workspace", async (t) => {
  const { root, home, folder } = await localHome(t);
  const skill = (name: string) =>
    `---\nname: ${name}\ndescription: From a folder\n---\nBody\n`;
  await write(root, "plain/keep/SKILL.md", skill("keep"));
  await write(root, "plain/gone/SKILL.md", skill("gone"));
  await write(root, "plain/gone/refs/note.md", "note");
  const installed = (name: string) =>
    readFile(join(folder, "org/skills", name, "SKILL.md"), "utf8");

  let asked = "";
  const answering = (answer: string): Partial<AddPrompts> => ({
    chooseOne: async (message) => {
      asked = message;
      return answer;
    },
  });
  await addSkills(
    join(root, "plain/keep"),
    {},
    quiet(home, answering("copy"), true),
  );
  expect(asked).toMatch(/Copy or move it/);
  expect(await installed("keep")).toMatch(/name: keep/);
  expect(await readFile(join(root, "plain/keep/SKILL.md"), "utf8")).toMatch(
    /name: keep/,
  );

  await addSkills(
    join(root, "plain/gone"),
    {},
    quiet(home, answering("move"), true),
  );
  expect(await installed("gone")).toMatch(/name: gone/);
  await expect(lstat(join(root, "plain/gone"))).rejects.toMatchObject({
    code: "ENOENT",
  });

  await write(root, "plain/left/SKILL.md", skill("left"));
  await write(root, "plain/left/.DS_Store", "not part of the Skill");
  await addSkills(join(root, "plain/left"), { move: true }, quiet(home));
  expect(await readdir(join(root, "plain/left"))).toStrictEqual([".DS_Store"]);

  await write(root, "plain/stays/SKILL.md", skill("stays"));
  await addSkills(join(root, "plain/stays"), { copy: true }, quiet(home));
  const entries = await readdir(join(root, "plain/stays"));
  expect(entries).toStrictEqual(["SKILL.md"]);

  await expect(
    addSkills(join(root, "plain/keep"), { updates: "auto" }, quiet(home)),
  ).rejects.toThrow(/no history to update from/);
  await expect(
    addHook(join(root, "plain/keep"), {}, quiet(home)),
  ).rejects.toThrow(/isn't a Git repo/);
});

test("setup asks nothing about an empty Git repo but still follows it", async () => {
  const written: string[] = [];
  const organizationId = "10000000-0000-4000-8000-000000000001";
  const selection = await environmentChooser((line) => written.push(line))({
    catalog: { assets: [], distributions: [] },
    scopes: [
      {
        type: "org",
        id: organizationId,
        slug: "org",
        name: "team-repo",
        canPublish: true,
      },
    ],
    previous: {
      subscriptions: [],
      individualAssetIds: [],
      excludedAssetIds: [],
      disabledAssetIds: [],
    },
    memberTeamIds: [],
    developerId: null,
    firstSetup: true,
  });
  expect(written.join("\n")).toMatch(/This repo has no assets yet/);
  expect(selection.subscriptions.map((s) => s.scope.id)).toStrictEqual([
    organizationId,
  ]);
});

test("copies of a Skill in different folders are told apart", async (t) => {
  const { root, home, folder } = await localHome(t);
  const skill = (body: string) =>
    `---\nname: focus\ndescription: Keeps you focused\n---\n${body}\n`;
  const { url } = await sourceRepo(root, "copies", {
    "skills/focus/SKILL.md": skill("Main"),
    ".cursor/skills/focus/SKILL.md": skill("Cursor"),
  });
  const body = () =>
    readFile(join(folder, "org/skills/renamed/SKILL.md"), "utf8");

  let offered: { value: string; short?: string; description?: string }[] = [];
  const pickMain: Partial<AddPrompts> = {
    chooseMany: async (_, choices) => {
      offered = choices;
      return ["skills/focus"];
    },
    chooseOne: async () => "manual",
  };
  await addSkills(url, { as: "renamed" }, quiet(home, pickMain, true));
  expect(await body()).toMatch(/Main/);
  expect(offered.map((c) => c.value).sort()).toStrictEqual([
    ".cursor/skills/focus",
    "skills/focus",
  ]);
  expect(
    offered.every((c) => c.description === "Description: Keeps you focused"),
  ).toBeTruthy();
  expect(offered.some((c) => c.short === "focus (skills/focus)")).toBeTruthy();

  await expect(addSkills(url, { all: true }, quiet(home))).rejects.toThrow(
    /focus is in more than one folder/,
  );
  await expect(
    addSkills(url, { only: ["focus"], as: "other" }, quiet(home)),
  ).rejects.toThrow(/focus is in more than one folder/);
  await addSkills(
    url,
    { only: [".cursor/skills/focus"], as: "by-folder", updates: "fork" },
    quiet(home),
  );
  expect(
    await readFile(join(folder, "org/skills/by-folder/SKILL.md"), "utf8"),
  ).toMatch(/Cursor/);
});

test("links copied from a browser are understood", () => {
  expect(parseLocation("acme/skills")).toStrictEqual({
    url: "https://github.com/acme/skills.git",
    rest: null,
  });
  expect(
    parseLocation("https://github.com/acme/skills/tree/feat/x/skills/review"),
  ).toStrictEqual({
    url: "https://github.com/acme/skills.git",
    rest: "feat/x/skills/review",
  });
  expect(parseLocation("git@github.com:acme/skills.git")).toStrictEqual({
    url: "git@github.com:acme/skills.git",
    rest: null,
  });
});

test("a Skill is added from a repo, updated on request and refuses to lose edits", async (t) => {
  const { root, home, folder } = await localHome(t);
  const { url, clone } = await sourceRepo(root, "skills", {
    ".claude/skills/review/SKILL.md": skill("review"),
    ".claude/skills/review/notes.md": "notes",
    "other/lint/SKILL.md": skill("lint"),
    "other/broken/SKILL.md": "no front matter",
  });
  await expect(addSkills(url, {}, quiet(home))).rejects.toThrow(/has 2 Skills/);
  await addSkills(url, { only: ["review"], updates: "manual" }, quiet(home));
  expect(await installed(home, "skills/review/SKILL.md")).toMatch(/review/);
  expect(
    await readFile(join(folder, "org/skills/review/notes.md"), "utf8"),
  ).toBe("notes");
  await expect(
    addSkills(url, { only: ["review"] }, quiet(home)),
  ).rejects.toSatisfy((error: CliError) =>
    /already exists/.test(error.message),
  );
  await write(
    clone,
    ".claude/skills/review/SKILL.md",
    skill("review", "Upstream."),
  );
  await commit(clone, "Change");
  const preview = await updateImported(
    "skill",
    "review",
    { dryRun: true },
    home,
  );
  expect(preview[0]!.changes.length).toBe(1);
  expect(
    await readFile(join(folder, "org/skills/review/SKILL.md"), "utf8"),
  ).not.toMatch(/Upstream/);
  await updateImported("skill", "review", {}, home);
  await synchronize(undefined, home);
  expect(await installed(home, "skills/review/SKILL.md")).toMatch(/Upstream/);
  await write(folder, "org/skills/review/SKILL.md", skill("review", "Mine."));
  await expect(updateImported("skill", "review", {}, home)).rejects.toThrow(
    /edited locally/,
  );
  await addSkills(
    url,
    { only: ["lint"], updates: "fork", as: "my-lint" },
    quiet(home),
  );
  expect(
    await readFile(join(folder, "org/skills/my-lint/SKILL.md"), "utf8"),
  ).toMatch(/name: my-lint/);
  await expect(updateImported("skill", "my-lint", {}, home)).rejects.toThrow(
    /nothing to update/,
  );
});

test("automatic Skills follow their repo at sync", async (t) => {
  const { root, home } = await localHome(t);
  const { url, clone } = await sourceRepo(root, "skills", {
    "review/SKILL.md": skill("review"),
  });
  await addSkills(url, { updates: "auto" }, quiet(home));
  await write(clone, "review/SKILL.md", skill("review", "Followed."));
  await commit(clone, "Change");
  await synchronize(undefined, home);
  expect(await installed(home, "skills/review/SKILL.md")).toMatch(/Followed/);
  await rm(url, { recursive: true, force: true });
  const events = await synchronize(undefined, home);
  expect(
    events.some(
      (e) => e.type === "notice" && e.message.includes("wasn't updated"),
    ),
  ).toBeTruthy();
  expect(await installed(home, "skills/review/SKILL.md")).toMatch(/Followed/);
});

test("a machine with only a Git workspace gains a local folder when adding", async (t) => {
  const { root, url } = await teamRepo(t);
  const home = join(root, "member");
  await setupGit(url, home);
  const source = await sourceRepo(root, "extra", {
    "extra/SKILL.md": skill("extra"),
  });
  await addSkills(source.url, { updates: "fork" }, quiet(home));
  const settings = await readSettings(home);
  expect(settings?.gitWorkspace && settings.localWorkspace).toBeTruthy();
  expect(await installed(home, "skills/extra/SKILL.md")).toMatch(/extra/);
});

test("a repo's hook.yaml is added as it is", async (t) => {
  const { root, home } = await localHome(t);
  const { url } = await sourceRepo(root, "hooks", {
    "audit/hook.yaml": hookYaml,
    "audit/audit.sh": "#!/bin/sh\n",
  });
  await addHook(url, { updates: "fork" }, quiet(home));
  expect(
    await readFile(
      join(home, ".barndog/installed/hooks/dev-local-audit/hook.yaml"),
      "utf8",
    ).catch(() =>
      readFile(
        join(home, ".barndog/installed/hooks/org-org-audit/hook.yaml"),
        "utf8",
      ),
    ),
  ).toBeTruthy();
  expect(JSON.stringify(await claudeSettings(home))).toMatch(/audit\.sh/);
});

test("native hook configs pre-fill the picker and carry over", async (t) => {
  const { root, home, folder } = await localHome(t);
  const { url } = await sourceRepo(root, "plugin", {
    "hooks/hooks.json": JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "python3 ${CLAUDE_PLUGIN_ROOT}/scripts/guard.py",
              },
              { type: "command", command: "echo inline" },
            ],
          },
        ],
      },
    }),
    ".cursor/hooks.json": JSON.stringify({
      version: 1,
      hooks: { beforeShellExecution: [{ command: "./scripts/guard.py" }] },
    }),
    "scripts/guard.py": "print('ok')\n",
    "scripts/helper.py": "x = 1\n",
  });
  await addHook(url, { as: "guard", updates: "manual" }, quiet(home));
  const manifest = await readFile(
    join(folder, "org/hooks/guard/hook.yaml"),
    "utf8",
  );
  expect(manifest).toMatch(/matcher: Bash/);
  expect(manifest).toMatch(/python3 \$\{BARNDOG_HOOK_ROOT\}\/guard\.py/);
  expect(manifest).toMatch(/beforeShellExecution/);
  expect(
    await readFile(join(folder, "org/hooks/guard/helper.py"), "utf8"),
  ).toBe("x = 1\n");
  expect(JSON.stringify(await claudeSettings(home))).toMatch(/guard\.py/);
});

test("plain scripts go through the picker for each coding tool", async (t) => {
  const { root, home, folder } = await localHome(t);
  const { url, clone } = await sourceRepo(root, "scripts", {
    "tools/check.sh": "#!/bin/sh\n",
  });
  await expect(addHook(url, {}, quiet(home))).rejects.toThrow(
    /Run this in a terminal/,
  );
  await addHook(
    url,
    {},
    quiet(
      home,
      {
        chooseOne: async () => "manual",
        chooseMany: async (message) =>
          message.startsWith("Which coding tools")
            ? ["claude", "cursor"]
            : message.startsWith("Claude")
              ? ["PreToolUse", "Stop"]
              : ["stop"],
        text: async (message, fallback) =>
          message.startsWith("PreToolUse")
            ? "Bash"
            : message === "Hook name"
              ? "check"
              : (fallback ?? ""),
      },
      true,
    ),
  );
  const manifest = await readFile(
    join(folder, "org/hooks/check/hook.yaml"),
    "utf8",
  );
  expect(manifest).toMatch(/matcher: Bash/);
  expect(manifest).toMatch(/cursor:/);
  expect(manifest).toMatch(/\$\{BARNDOG_HOOK_ROOT\}\/check\.sh/);
  // Updating keeps the choices made in the picker and takes the new script.
  await write(clone, "tools/check.sh", "#!/bin/sh\necho new\n");
  await commit(clone, "Change");
  await updateImported("hook", "check", {}, home);
  expect(
    await readFile(join(folder, "org/hooks/check/check.sh"), "utf8"),
  ).toMatch(/echo new/);
  expect(
    await readFile(join(folder, "org/hooks/check/hook.yaml"), "utf8"),
  ).toMatch(/matcher: Bash/);
});

test("a link to a folder reads only that folder", async (t) => {
  const { root } = await localHome(t);
  const settings = (event: string, script: string) =>
    JSON.stringify({
      hooks: {
        [event]: [
          {
            hooks: [
              {
                type: "command",
                command: `node \${CLAUDE_PLUGIN_ROOT}/${script}`,
              },
            ],
          },
        ],
      },
    });
  const { url } = await sourceRepo(root, "plugins", {
    "plugins/audit/hooks/hooks.json": settings("Stop", "guard.js"),
    "plugins/audit/guard.js": "// audit\n",
    "plugins/audit/report.js": "// report\n",
    "plugins/block/hooks/hooks.json": settings("PreToolUse", "guard.js"),
    "plugins/block/guard.js": "// block\n",
    "plugins/block/skills/explain/SKILL.md":
      "---\nname: explain\ndescription: Explains a block\n---\n",
    "skills/review/SKILL.md":
      "---\nname: review\ndescription: Reviews code\n---\n",
    "docs/README.md": "# Docs\n",
  });
  const at = <T>(
    path: string,
    use: Parameters<typeof fetchRemote<T>>[2],
  ): Promise<T> =>
    fetchRemote(
      { url, rest: null, ref: null, path },
      { allowPrompt: false },
      use,
    );
  await at("plugins/block", async (remote) => {
    const { candidates, skipped } = discoverHooks(remote, "block");
    expect(skipped).toStrictEqual([]);
    expect(candidates.length).toBe(1);
    const draft = candidates[0]!;
    expect(draft.type).toBe("draft");
    if (draft.type !== "draft") return;
    expect(draft.scripts).toStrictEqual(["plugins/block/guard.js"]);
    expect(draft.implementations).toStrictEqual({
      claude: [
        {
          event: "PreToolUse",
          matcher: undefined,
          script: "plugins/block/guard.js",
          command: "node @@plugins/block/guard.js",
        },
      ],
    });
    expect(
      discoverSkills(remote).skills.map((skill) => skill.name),
    ).toStrictEqual(["explain"]);
  });
  // The whole repo is still searched when the link names no folder.
  await at("", async (remote) => {
    const draft = discoverHooks(remote, "plugins").candidates[0]!;
    expect(draft.type === "draft" && draft.scripts.length).toBe(3);
    expect(discoverSkills(remote).skills.length).toBe(2);
  });
  // A folder with nothing in it is a miss, not a reason to look elsewhere.
  await at("docs", async (remote) => {
    expect(scopeExists(remote)).toBe(true);
    expect(discoverHooks(remote, "docs").candidates).toStrictEqual([]);
    expect(discoverSkills(remote).skills).toStrictEqual([]);
  });
  await at("plugins/missing", async (remote) => {
    expect(scopeExists(remote)).toBe(false);
  });
});

test("a Hook is added only for the coding tools it was written for", async (t) => {
  const { root, home, folder } = await localHome(t);
  const { url } = await sourceRepo(root, "guard", {
    "hooks/hooks.json": JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "node ${CLAUDE_PLUGIN_ROOT}/guard.js",
              },
              {
                type: "command",
                command: "node ${CLAUDE_PLUGIN_ROOT}/audit.js",
              },
            ],
          },
        ],
      },
    }),
    "guard.js": "// guard\n",
    "audit.js": "// audit\n",
  });
  const settings = (await readSettings(home))!;
  await saveSettings({ ...settings, harnesses: ["claude", "cursor"] }, home);
  // The picker never offers a tool the Hook has no settings for.
  const lines: string[] = [];
  await addHook(
    url,
    { as: "guard", updates: "manual" },
    {
      ...quiet(home, { chooseOne: async (_, __, fallback) => fallback! }, true),
      write: (line) => lines.push(line),
    },
  );
  const manifest = parse(
    await readFile(join(folder, "org/hooks/guard/hook.yaml"), "utf8"),
  ) as { implementations: Record<string, { compatibility: string }> };
  expect(Object.keys(manifest.implementations)).toStrictEqual(["claude"]);
  expect(manifest.implementations.claude!.compatibility).toBe("supported");
  const output = lines.join("\n");
  // This machine uses Claude Code and Cursor: one prompt covers what's missing.
  expect(output).toMatch(/written for Claude Code\. It won't run in Cursor/);
  expect(output.match(/Adapt the BarnDog Hook "guard"/g)?.length).toBe(1);
  expect(output).toMatch(/so it also runs in Cursor\./);
  expect(output).toMatch(
    new RegExp(`Files: ${join(folder, "org/hooks/guard")}`),
  );
  expect(output).toMatch(/still follows it/);
  expect(output).toMatch(
    /Claude Code, PreToolUse, matcher "Bash": node \$\{BARNDOG_HOOK_ROOT\}\/audit\.js/,
  );
  expect(output).toMatch(/barndog hooks adapt guard --origin local/);
  expect(output).not.toMatch(/barndog local move/);
  // The command prints the same prompt, and one prompt names every tool asked for.
  const again = await adaptHook("guard", "local", undefined, home);
  expect([again.written, again.targets]).toStrictEqual([
    ["claude"],
    ["cursor"],
  ]);
  expect(output).toContain(again.prompt!);
  const both = await adaptHook("guard", "local", ["codex", "cursor"], home);
  expect(both.prompt!).toMatch(/so it also runs in Codex and Cursor\./);
  await expect(adaptHook("guard", "local", ["claude"], home)).rejects.toThrow(
    /already has settings for Claude Code/,
  );
});

test("a Hook that covers this machine's coding tools needs no prompt", async (t) => {
  const { root, home, folder } = await localHome(t);
  const { url } = await sourceRepo(root, "both", {
    "hooks/hooks.json": JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "${CLAUDE_PLUGIN_ROOT}/claude/run.sh",
              },
            ],
          },
        ],
      },
    }),
    ".cursor/hooks.json": JSON.stringify({
      version: 1,
      hooks: { stop: [{ command: "./cursor/run.sh" }] },
    }),
    "claude/run.sh": "#!/bin/sh\n",
    "cursor/run.sh": "#!/bin/sh\n",
  });
  const settings = (await readSettings(home))!;
  await saveSettings({ ...settings, harnesses: ["claude", "cursor"] }, home);
  const lines: string[] = [];
  await addHook(
    url,
    { as: "both", updates: "fork" },
    { ...quiet(home), write: (line) => lines.push(line) },
  );
  const output = lines.join("\n");
  expect(output).not.toMatch(/Adapt the BarnDog Hook/);
  // Each tool has its own script, so changing one leaves the other behind.
  expect(output).toMatch(
    /Claude Code and Cursor run different scripts in this Hook/,
  );
  expect(await folderDivergence(join(folder, "org/hooks/both"))).toBe(
    "Claude Code and Cursor run different scripts in this Hook. When you change it for one, check whether the others need the same change.",
  );
  expect((await adaptHook("both", "local", undefined, home)).prompt).toBe(null);
});

test("the adapt prompt follows where the Hook lives", () => {
  const implementations = {
    cursor: {
      compatibility: "supported" as const,
      scripts: ["run.sh"],
      requirements: { commands: [] },
      events: { stop: [{ command: "${BARNDOG_HOOK_ROOT}/run.sh" }] },
    },
  };
  const local = adaptPrompt({
    name: "tidy",
    implementations,
    targets: ["claude", "codex"],
    place: { type: "folder", path: "/work/org/hooks/tidy", shareable: true },
  });
  expect(local).toMatch(/written for Cursor only/);
  expect(local).toMatch(/also runs in Claude Code and Codex\./);
  expect(local).toMatch(/- Cursor, stop: \$\{BARNDOG_HOOK_ROOT\}\/run\.sh/);
  expect(local).toMatch(/Run `barndog sync` to install it/);
  expect(local).toMatch(/barndog local move tidy/);
  expect(local).not.toMatch(/still follows/);
  const shared = adaptPrompt({
    name: "tidy",
    implementations,
    targets: ["claude"],
    place: { type: "workspace", origin: "team/web", review: "a pull request" },
  });
  expect(shared).toMatch(/barndog hooks pull tidy --origin team\/web/);
  expect(shared).toMatch(
    /`barndog hooks push` to propose the change as a pull request/,
  );
  expect(shared).not.toMatch(/barndog sync/);
});

test("hook commands get the root variable their coding tool sets", () => {
  expect(hookCommand("/tmp/hook", "run", "claude")).toBe(
    "export BARNDOG_HOOK_ROOT='/tmp/hook' CLAUDE_PLUGIN_ROOT='/tmp/hook'; run",
  );
  expect(hookCommand("/tmp/hook", "run", "codex")).toBe(
    "export BARNDOG_HOOK_ROOT='/tmp/hook' PLUGIN_ROOT='/tmp/hook'; run",
  );
  expect(hookCommand("/tmp/hook", "run", "cursor")).toMatch(
    /CURSOR_PLUGIN_ROOT/,
  );
  expect(hookCommand("/tmp/hook", "run")).toBe(
    "export BARNDOG_HOOK_ROOT='/tmp/hook'; run",
  );
});

test("events chosen for one coding tool start selected for the next", async (t) => {
  const { home } = await localHome(t);
  const offered: Record<string, string[]> = {};
  const scripts: Record<string, string | undefined> = {};
  const plan = await pickHookPlan(
    {
      type: "draft",
      name: "guard",
      scripts: ["a.sh", "b.sh"],
      implementations: {},
      skipped: [],
    },
    () => true,
    quiet(
      home,
      {
        chooseMany: async (message, choices) => {
          if (message.startsWith("Which coding tools"))
            return ["claude", "codex", "cursor"];
          const checked = choices
            .filter((choice) => choice.checked)
            .map((choice) => choice.value);
          offered[message.split(":")[0]!] = checked;
          return message.startsWith("Claude")
            ? ["PreToolUse", "Stop", "Notification"]
            : checked;
        },
        chooseOne: async (message, _, fallback) => {
          scripts[message] = fallback;
          return fallback ?? "b.sh";
        },
      },
      true,
    ),
  );
  expect(offered["Claude Code"]).toStrictEqual([]);
  expect(offered.Codex).toStrictEqual(["PreToolUse", "Stop"]);
  expect(offered.Cursor).toStrictEqual(["preToolUse", "stop"]);
  expect(scripts["Claude Code PreToolUse: which script?"]).toBe(undefined);
  expect(scripts["Codex PreToolUse: which script?"]).toBe("b.sh");
  expect(
    plan.cursor?.map((event) => [event.event, event.script]),
  ).toStrictEqual([
    ["preToolUse", "b.sh"],
    ["stop", "b.sh"],
  ]);
});

test("pasted MCP JSON never stores a secret and installs everywhere", async (t) => {
  const { home, folder } = await localHome(t);
  await addMcp(
    undefined,
    {
      config: JSON.stringify({
        mcpServers: {
          docs: {
            url: "https://docs.example.com/mcp",
            headers: {
              Authorization: "Bearer real-secret-value",
              "X-Team": "${TEAM_ID}",
            },
          },
          local: {
            command: "node",
            args: ["server.js"],
            env: { API_KEY: "real-secret-value" },
          },
        },
      }),
    },
    quiet(home),
  );
  const docs = await readFile(join(folder, "org/mcp/docs.yaml"), "utf8");
  const local = await readFile(join(folder, "org/mcp/local.yaml"), "utf8");
  expect(docs + local).not.toMatch(/real-secret-value/);
  expect(docs).toMatch(/secretRef: TEAM_ID/);
  expect(docs).toMatch(/secretRef: DOCS_AUTHORIZATION/);
  expect(local).toMatch(/secretRef: API_KEY/);
  expect(await readFile(join(home, ".claude.json"), "utf8")).toMatch(
    /docs\.example\.com/,
  );
  expect(() => parseMcpText(JSON.stringify({ command: "x" }))).toThrow(
    /without a name/,
  );
  expect(() => parseMcpText("{")).toThrow(/valid JSON/);
  expect(() =>
    convertServer({
      name: "a",
      server: { url: "https://x.example.com", type: "sse" },
    }),
  ).toThrow(/stdio and HTTP/);
  expect(() =>
    convertServer({
      name: "a",
      server: { url: "https://x.example.com/?key=1" },
    }),
  ).toThrow(/can't be added/);
});

test("importing from a harness replaces its entry and keeps a backup", async (t) => {
  const { home, folder } = await localHome(t);
  const original = {
    mcpServers: {
      tools: { command: "node", args: ["t.js"] },
      other: { command: "x" },
    },
  };
  await write(home, ".claude.json", JSON.stringify(original));
  await write(
    home,
    ".codex/config.toml",
    '[mcp_servers.codexonly]\ncommand = "c"\nenv_vars = ["TOKEN"]\n',
  );
  expect((await harnessServers(home)).map((s) => s.name).sort()).toStrictEqual([
    "codexonly",
    "other",
    "tools",
  ]);
  await expect(
    addMcp("tools", { from: "claude" }, quiet(home)),
  ).rejects.toSatisfy(
    (error: CliError) => error.hint === "barndog mcp add tools --replace",
  );
  await expect(readFile(join(folder, "org/mcp/tools.yaml"))).rejects.toThrow();
  expect(
    JSON.parse(await readFile(join(home, ".claude.json"), "utf8")),
  ).toStrictEqual(original);
  await addMcp("tools", { from: "claude", replace: true }, quiet(home));
  expect(await readFile(join(folder, "org/mcp/tools.yaml"), "utf8")).toMatch(
    /t\.js/,
  );
  const after = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
  expect(after.mcpServers.tools).toBeTruthy();
  expect(after.mcpServers.other).toStrictEqual({ command: "x" });
  // BarnDog owns it now, so it no longer shows up as something to import.
  expect(
    (await harnessServers(home)).some(
      (s) => s.name === "tools" && s.harness === "claude",
    ),
  ).toBeFalsy();
  await addMcp("codexonly", { from: "codex" }, quiet(home));
  expect(
    await readFile(join(folder, "org/mcp/codexonly.yaml"), "utf8"),
  ).toMatch(/secretRef: TOKEN/);
});

test("a local-only machine can promote to a repo without switching", async (t) => {
  const { root, url, clone } = await teamRepo(t);
  const home = join(root, "dev");
  const folder = await setupLocal(home);
  await write(folder, "org/skills/mine/SKILL.md", skill("mine"));
  await synchronize(undefined, home);
  const result = await moveLocalAssets(
    { repo: url, to: "team/web", names: ["mine"] },
    home,
  );
  expect(result.rows.map((r) => r.status)).toStrictEqual(["moved"]);
  await run(clone, "fetch", "origin");
  expect(
    await run(
      clone,
      "show",
      `origin/${result.branch}:teams/web/skills/mine/SKILL.md`,
    ),
  ).toMatch(/mine/);
  const settings = await readSettings(home);
  expect(
    settings && settings.localWorkspace && !settings.gitWorkspace,
  ).toBeTruthy();
  expect(await installed(home, "skills/mine/SKILL.md")).toMatch(/mine/);
  await assertCommandAvailable(
    ["login"],
    { server: "https://x.example.com" },
    home,
  );
  await assertCommandAvailable(
    ["skills", "promote"],
    { origin: "local" },
    home,
  );
  await expect(
    moveLocalAssets({ server: "http://127.0.0.1:9" }, home),
  ).rejects.toSatisfy(
    (error: CliError) =>
      error.hint === "barndog login --server http://127.0.0.1:9",
  );
});

test("promote from local routes to the same move", async (t) => {
  const { root, url, clone } = await teamRepo(t);
  const home = join(root, "dev");
  const folder = await setupLocal(home);
  await write(folder, "org/skills/mine/SKILL.md", skill("mine"));
  await setupGit(url, home, "keep");
  const result = await promote(
    {
      kind: "skill",
      name: "mine",
      origin: "local",
      target: "team/web",
      newName: "shared-mine",
    },
    home,
  );
  assert(result.outcome === "moved");
  await run(clone, "fetch", "origin");
  expect(
    await run(
      clone,
      "show",
      `origin/${result.move.branch}:teams/web/skills/shared-mine/SKILL.md`,
    ),
  ).toMatch(/name: shared-mine/);
});

test("help hides what the current setup can't run and says so at the end", async () => {
  const help = async (
    setupMode: "local" | "git" | undefined,
    ...args: string[]
  ) => {
    const lines: string[] = [];
    await expect(
      createProgram({
        ...(setupMode ? { setupMode } : {}),
        write: (line) => lines.push(line),
      }).parseAsync(["node", "barndog", ...args, "--help"]),
    ).rejects.toSatisfy((error: { exitCode?: number }) => error.exitCode === 0);
    return lines.join("\n").replace(/\s+/g, " ");
  };
  const listed = (text: string, command: string) =>
    new RegExp(` ${command} (\\[|<|[A-Z])`).test(
      text.split("Some commands are")[0]!,
    );

  const root = await help("local");
  expect(listed(root, "login")).toBe(false);
  expect(listed(root, "github")).toBe(false);
  expect(listed(root, "sync")).toBe(true);
  expect(root).not.toMatch(/Not available/);
  expect(root).toMatch(
    /Some commands are hidden in local mode because they need a Git repo or Cloud Workspace: .*login.*github/,
  );
  expect(root).toMatch(/Run barndog --help --list-unavailable to see them\./);

  const skills = await help("local", "skills");
  expect(skills).not.toMatch(/\b(fork|pull) \[options\] \[name\] {2,}/);
  expect(skills).toMatch(/add \[options\] <source>/);
  expect(skills).not.toMatch(/promote \[options\]/);
  expect(skills).toMatch(/Workspace: .*fork.*promote.*pull/);
  expect(skills).toMatch(/barndog skills --help --list-unavailable/);

  const all = await help("local", "skills", "--list-unavailable");
  expect(all).toMatch(/fork .*Needs a Cloud Workspace\./);
  expect(all).toMatch(/pull .*Needs a Git repo or Cloud Workspace\./);
  expect(all).not.toMatch(/Some commands are/);

  const group = await help("local", "github");
  expect(group).toMatch(
    /Not available in local mode\. Needs a Cloud Workspace\./,
  );
  expect(group).not.toMatch(/Some commands are/);

  const gitSkills = await help("git", "skills");
  expect(gitSkills).toMatch(/pull \[options\]/);
  expect(gitSkills).toMatch(
    /Some commands are hidden in Git mode because they need a Cloud Workspace:/,
  );

  const cloud = await help(undefined);
  expect(cloud).not.toMatch(/Not available|Some commands are|list-unavailable/);
  expect(listed(cloud, "login")).toBe(true);
});

test("a moved asset is used from its new scope once it exists there, and removing it sticks", async (t) => {
  const { root, url, clone } = await teamRepo(t);
  const home = join(root, "dev");
  const folder = await setupLocal(home);
  await write(folder, "org/skills/mine/SKILL.md", skill("mine"));
  await setupGit(url, home, "keep");
  const result = await moveLocalAssets(
    { names: ["mine"], to: "team/web" },
    home,
  );
  await run(clone, "fetch", "origin");
  await run(clone, "merge", "--no-edit", `origin/${result.branch}`);
  await run(clone, "push", "origin", "main");
  await synchronize(undefined, home, undefined, { prompt: false });
  const items = (await inventory(home)).items.filter((i) => i.name === "mine");
  expect(items.map((i) => [i.origin, i.state])).toStrictEqual([
    ["team/web", "installed"],
  ]);
  await changeAsset(
    "remove",
    { kind: "skill", name: "mine", origin: "team/web" },
    home,
  );
  await synchronize(undefined, home, undefined, { prompt: false });
  expect(
    (await inventory(home)).items.filter(
      (i) =>
        i.name === "mine" && i.origin === "team/web" && i.state === "installed",
    ).length,
  ).toBe(0);
});

test("internal codes and validation errors read as sentences", () => {
  expect(friendlyMessage(new Error("INVALID_SKILL_MD"))).toBe(
    "SKILL.md needs front matter with a lowercase hyphenated name and a description",
  );
  expect(friendlyMessage(new Error("MISSING_HOOK_SCRIPT: a.sh"))).toBe(
    "hook.yaml declares a script that isn't in the folder: a.sh",
  );
  expect(friendlyMessage(new Error("KNOWLEDGE_NOT_FOUND"))).toBe(
    "Knowledge not found.",
  );
  expect(
    friendlyMessage(
      Object.assign(new Error("x"), { code: "ENOENT", path: "/a" }),
    ),
  ).toBe("Can't find /a.");
  expect(
    friendlyMessage(
      Object.assign(new Error("x"), { code: "EEXIST", path: "/a" }),
    ),
  ).toBe("/a already exists. Choose another folder or remove it first.");
  expect(friendlyMessage(z.uuid().safeParse("x").error)).toMatch(
    /isn't a valid ID/,
  );
});
