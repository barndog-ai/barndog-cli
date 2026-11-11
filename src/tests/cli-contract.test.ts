import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { ApiError, mcpDefinitionSchema } from "@barndog-ai/api-contract";

import { assertCommandAvailable } from "../commands/availability.js";
import { CliError } from "../errors.js";
import { selectedText } from "../features/collaboration/index.js";
import { synchronize } from "../features/environment/sync.js";
import { assertSourceExists } from "../features/imports/folder.js";
import { convertServer } from "../features/imports/mcp.js";
import { inventory } from "../features/inventory/index.js";
import {
  knowledgeList,
  knowledgeProblems,
} from "../features/knowledge/index.js";
import { doctor } from "../features/doctor/index.js";
import { mcpEntry } from "../features/native/adapters.js";
import { createProgram } from "../program.js";
import { addMcp, addSkills, type AddContext } from "../ui/add-asset.js";
import { renderCollaboration } from "../ui/collaboration.js";
import { renderValue } from "../ui/format.js";
import { renderMcp } from "../ui/mcp.js";
import { runSetup } from "../ui/onboarding.js";
import {
  renderError,
  renderJsonError,
  renderSyncOutput,
} from "../ui/output.js";
import { readSettings } from "../config/settings.js";

const plain = (lines: string[]) =>
  // eslint-disable-next-line no-control-regex
  lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");

async function temp(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "barndog-cli-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function localHome(t: TestContext) {
  const root = await temp(t);
  const home = join(root, "home");
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
  assert.ok(settings?.version === 2 && settings.localWorkspace);
  return { root, home, folder: settings.localWorkspace.path };
}

const quiet = (home: string): AddContext => ({
  home,
  interactive: false,
  write: () => {},
  prompts: {} as AddContext["prompts"],
});

function program(overrides: Parameters<typeof createProgram>[0] = {}) {
  const output: string[] = [];
  const instance = createProgram({
    interactive: false,
    write: (line) => output.push(line),
    writeError: () => {},
    ...overrides,
  });
  return { instance, output };
}

async function addSkill(root: string, home: string) {
  const source = join(root, "source", "review");
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, "SKILL.md"),
    "---\nname: review\ndescription: Reviews\n---\nBody\n",
  );
  await addSkills(source, { copy: true }, quiet(home));
  return join(home, ".barndog/installed/skills/review");
}

test("mcp add takes JSON through --config, leaving --json as the output flag", async (t) => {
  const { home, folder } = await localHome(t);
  await addMcp(
    "docs",
    { config: JSON.stringify({ command: "node", args: ["server.js"] }) },
    quiet(home),
  );
  assert.match(
    await readFile(join(folder, "org/mcp/docs.yaml"), "utf8"),
    /command: node/,
  );
  await assert.rejects(
    addMcp('{"command":"node"}', {}, quiet(home)),
    /looks like the configuration/,
  );
  const { instance } = program({
    capability: async () => undefined,
  });
  const add = instance.commands
    .find((c) => c.name() === "mcp")!
    .commands.find((c) => c.name() === "add")!;
  assert.ok(add.options.some((o) => o.long === "--config"));
  assert.ok(!add.options.some((o) => o.long === "--json"));
});

test("mcp add marks OAuth servers, by flag or from the pasted JSON", () => {
  const server = { name: "docs", server: { url: "https://docs.test/mcp" } };
  assert.equal(
    convertServer(server).definition.authentication,
    "none",
    "nothing says this server signs in",
  );
  const flagged = convertServer(server, undefined, true);
  assert.equal(flagged.definition.authentication, "native-oauth");
  assert.match(flagged.notes.join(), /mcp auth docs --origin local/);
  assert.equal(
    convertServer({
      name: "docs",
      server: { url: "https://docs.test/mcp", oauth: { clientId: "x" } },
    }).definition.authentication,
    "native-oauth",
  );
  assert.throws(
    () =>
      convertServer(
        { name: "tool", server: { command: "node" } },
        undefined,
        true,
      ),
    /only HTTP servers/,
  );
});

test("--json covers review commands and selection changes", async () => {
  const change = [{ id: "1", name: "a", status: "open", revision: 1 }];
  const list = program({ collaborate: async () => change });
  await list.instance.parseAsync(["changes", "list", "--json"], {
    from: "user",
  });
  assert.deepEqual(JSON.parse(list.output.join("\n")), change);

  const removed = { status: "applied", events: [] };
  const selection = program({ environment: async () => removed });
  await selection.instance.parseAsync(
    ["skills", "remove", "x", "--origin", "org", "--json"],
    { from: "user" },
  );
  assert.deepEqual(JSON.parse(selection.output.join("\n")), removed);
});

test("failures render as JSON with the same fix people see", () => {
  const error = new CliError("It broke.", "barndog sync");
  assert.deepEqual(JSON.parse(renderJsonError(error)), {
    error: { message: "It broke.", fix: "barndog sync" },
  });
  assert.deepEqual(
    JSON.parse(
      renderJsonError(new ApiError(403, "X", "PUBLICATION_FORBIDDEN")),
    ),
    {
      error: {
        message:
          "You can't publish here directly. Propose it for review instead.",
        fix: "barndog push",
        status: 403,
      },
    },
  );
});

test("common server refusals carry a Fix line", () => {
  const text = renderError(new ApiError(403, "X", "CHANGE_AUTHOR_REQUIRED"));
  assert.match(text, /Only the author/);
  assert.match(text, /Fix:.*barndog push --new/);
});

test("a change ID from the other list points there", async () => {
  const { instance } = program({
    collaborate: async () => {
      throw new ApiError(404, "X", "CHANGE_NOT_FOUND");
    },
  });
  await assert.rejects(
    instance.parseAsync(["changes", "show", "abc"], { from: "user" }),
    (error: CliError) =>
      /No Skill/.test(error.message) &&
      error.hint === "barndog hooks changes show abc",
  );
});

test("skills update installs what it changed", async () => {
  let synced = 0;
  const { instance, output } = program({
    capability: async () => [{ name: "a", changes: [] }],
    synchronize: async () => {
      synced += 1;
      return [];
    },
  });
  await instance.parseAsync(["skills", "update"], { from: "user" });
  assert.equal(synced, 0, "nothing changed, so nothing to install");
  const changed = program({
    capability: async () => [
      { name: "a", changes: [{ kind: "modified", path: "x", patch: "" }] },
    ],
    synchronize: async () => {
      synced += 1;
      return [];
    },
  });
  await changed.instance.parseAsync(["skills", "update"], { from: "user" });
  assert.equal(synced, 1);
  assert.match(plain(changed.output), /Update installed/);
  assert.equal(output.join("").includes("Update installed"), false);
});

test("status flags a hand-edited install the way sync and doctor do", async (t) => {
  const { root, home, folder } = await localHome(t);
  const installed = await addSkill(root, home);
  const before = (await inventory(home)).items.find((i) => i.name === "review");
  assert.equal(before?.state, "installed");
  await writeFile(join(installed, "SKILL.md"), "edited");
  const after = (await inventory(home)).items.find((i) => i.name === "review");
  assert.equal(after?.state, "modified");
  await assert.rejects(
    synchronize(undefined, home),
    (error: CliError) =>
      /copy that folder somewhere else/.test(error.message) &&
      !/skills pull/.test(error.message),
  );
  assert.ok(folder);
});

test("a knowledge file with a bad field is reported, not dropped silently", async (t) => {
  const { home, folder } = await localHome(t);
  await mkdir(join(folder, "org/knowledge"), { recursive: true });
  await writeFile(
    join(folder, "org/knowledge/guide.md"),
    "---\ndescription: Guide\naccess: always\n---\nBody\n",
  );
  const [problem] = await knowledgeProblems(home);
  assert.equal(problem?.path, "org/knowledge/guide.md");
  assert.match(problem!.reason, /access/);
  const events = await synchronize(undefined, home);
  assert.ok(
    events.some(
      (e) => e.type === "notice" && e.message.includes("guide.md was skipped"),
    ),
  );
  assert.ok((await doctor(home)).some((c) => /guide\.md/.test(c.detail)));
});

test("knowledge list reflects whether session-start listing is on", async (t) => {
  const { home, folder } = await localHome(t);
  await mkdir(join(folder, "org/knowledge"), { recursive: true });
  await writeFile(
    join(folder, "org/knowledge/guide.md"),
    "---\ndescription: Guide\naccessMode: always\n---\nBody\n",
  );
  assert.equal((await knowledgeList(home))[0]?.listedAtStart, true);
  const path = join(home, ".barndog/config.yaml");
  await writeFile(path, `${await readFile(path, "utf8")}\nknowledge: false\n`);
  const text = await readFile(path, "utf8");
  await writeFile(
    path,
    `${text.replace(/^knowledge: true\n/m, "").trimEnd()}\n`,
  );
  assert.equal((await knowledgeList(home))[0]?.listedAtStart, false);
  const { instance, output } = program({
    capability: async (action) =>
      action === "knowledge-list"
        ? [
            {
              name: "guide",
              description: "Guide",
              accessMode: "always",
              listedAtStart: false,
            },
          ]
        : [],
  });
  await instance.parseAsync(["knowledge", "list"], { from: "user" });
  assert.doesNotMatch(plain(output), /every session/);
  assert.match(plain(output), /barndog knowledge enable/);
});

test("sync doesn't call skipped or stale results up to date", () => {
  const skipped = plain(
    renderSyncOutput([
      { type: "invalid", kind: "skill", name: "bad", reason: "Broken" },
    ]),
  );
  assert.doesNotMatch(skipped, /Everything is up to date/);
  assert.match(skipped, /Nothing else changed/);
  const stale = plain(
    renderSyncOutput([{ type: "notice", message: "Can't reach the repo." }]),
  );
  assert.doesNotMatch(stale, /Everything is up to date/);
  assert.match(plain(renderSyncOutput([])), /Everything is up to date/);
});

test("sync keeps BarnDog's own entries out of the summary", () => {
  const events = [
    {
      type: "native" as const,
      action: "unchanged" as const,
      kind: "knowledge" as const,
      harness: "claude" as const,
      name: "knowledge index",
    },
    {
      type: "native" as const,
      action: "unchanged" as const,
      kind: "sync" as const,
      harness: "claude" as const,
      name: "workspace sync",
    },
    {
      type: "native" as const,
      action: "unchanged" as const,
      kind: "mcp" as const,
      harness: "claude" as const,
      name: "playwright",
    },
  ];
  const quiet = plain(renderSyncOutput(events));
  assert.match(quiet, /Sync complete · 1 unchanged/);
  assert.doesNotMatch(quiet, /knowledge index|workspace sync/);
  const verbose = plain(renderSyncOutput(events, { verbose: true }));
  assert.match(verbose, /Sync complete · 1 unchanged/);
  assert.match(verbose, /knowledge index/);
  assert.match(verbose, /workspace sync/);
  const installed = plain(
    renderSyncOutput([{ ...events[1]!, action: "installed" as const }]),
  );
  assert.doesNotMatch(installed, /workspace sync|1 installed/);
  assert.match(installed, /Restart your coding tools/);
});

test("review output uses names and hides noise about new files", () => {
  const diff = (oldExecutable: unknown, newExecutable: unknown) =>
    renderCollaboration("diff", [
      { kind: "added", path: "a", patch: "", oldExecutable, newExecutable },
    ]).join("\n");
  assert.doesNotMatch(diff(null, false), /executable/);
  assert.match(diff(null, true), /executable/);
  assert.match(diff(false, true), /executable: false → true/);
  const [row] = renderCollaboration("versions", [
    {
      number: 2,
      commit: "abc",
      description: "Second",
      publishedBy: "uuid-1",
      publisherName: "Alice Doe",
    },
  ]);
  assert.match(row!, /published by Alice Doe/);
  assert.doesNotMatch(row!, /uuid-1/);
});

test("MCP details read as fields and keep variable names exact", () => {
  const definition = mcpDefinitionSchema.parse({
    description: "Docs",
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    environment: { E2E_MCP_TOKEN: { secretRef: "E2E_MCP_TOKEN" } },
    authentication: "environment",
  });
  const text = plain(
    renderMcp({
      name: "docs",
      origin: { type: "org", id: "1", slug: "org" },
      version: { number: 3, definition },
    }),
  );
  assert.match(text, /v3/);
  assert.match(text, /node server\.js/);
  assert.match(text, /E2E_MCP_TOKEN from \$E2E_MCP_TOKEN/);
  assert.doesNotMatch(text, /\[object|E2e mcp/);
  assert.match(plain(renderValue({ E2E_MCP_TOKEN: "x" })), /E2E_MCP_TOKEN/);
});

test("a text file's closing newline isn't part of the selected lines", () => {
  assert.equal(selectedText("one\ntwo\n", 2), "one\ntwo");
  assert.equal(selectedText("one\ntwo", 2), "one\ntwo");
  assert.equal(
    selectedText("one\n", 2),
    "one\n",
    "range ends on an empty line",
  );
  assert.equal(selectedText("new\n"), "new");
});

test("assets install accepts override decisions", async () => {
  let seen: Record<string, unknown> = {};
  const { instance } = program({
    environment: async (_, options) => {
      seen = options as Record<string, unknown>;
      return { status: "applied", events: [] };
    },
  });
  await instance.parseAsync(
    ["skills", "install", "x", "--origin", "org", "--overrides", "preserve"],
    { from: "user" },
  );
  assert.equal(seen.overrides, "preserve");
});

test("an unavailable command says so before asking for its flags", async (t) => {
  const { home } = await localHome(t);
  const { instance } = program({
    guard: (path, options) => assertCommandAvailable(path, options, home),
  });
  await assert.rejects(
    instance.parseAsync(["mcp", "create", "x"], { from: "user" }),
    /needs a BarnDog Cloud Workspace/,
  );
});

test("Codex entries omit an empty header table", () => {
  const definition = mcpDefinitionSchema.parse({
    description: "Docs",
    transport: "http",
    url: "https://docs.test/mcp",
    authentication: "native-oauth",
  });
  const entry = mcpEntry(
    "codex",
    { id: "1", name: "docs" },
    definition,
    "/home",
  );
  assert.equal("env_http_headers" in entry.value, false);
});

test("a missing path is reported as missing, not as something to clone", () => {
  assert.throws(() => assertSourceExists("/missing/path"), /Can't find/);
  assert.doesNotThrow(() => assertSourceExists("github.com/acme/skills"));
  assert.doesNotThrow(() => assertSourceExists("https://x.test/a.git"));
});

test("cancelling first-time local setup leaves no folder behind", async (t) => {
  const root = await temp(t);
  const home = join(root, "home");
  await runSetup({
    home,
    local: true,
    restart: true,
    interactive: true,
    detected: [],
    write: () => {},
    confirmRestart: async () => true,
    confirmApply: async () => false,
    choose: async () => ["claude"],
  });
  assert.equal(existsSync(join(home, ".barndog/workspace")), false);
  assert.equal(existsSync(join(home, ".barndog/sync.lock")), false);
});

test("a stopped process releases the environment lock", async (t) => {
  const home = join(await temp(t), "home");
  const transaction = fileURLToPath(
    new URL("../features/environment/transaction.js", import.meta.url),
  );
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { locked } = await import(${JSON.stringify(transaction)});
       await locked(${JSON.stringify(home)}, () => new Promise(() => setInterval(() => {}, 1000)));`,
    ],
    { stdio: "ignore" },
  );
  const lock = join(home, ".barndog/sync.lock");
  for (let i = 0; i < 200 && !existsSync(join(lock, "pid")); i++)
    await sleep(25);
  assert.equal(existsSync(join(lock, "pid")), true);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
  assert.equal(existsSync(lock), false);
});
