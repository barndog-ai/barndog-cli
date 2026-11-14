import { assert, expect, test, vi, type TestContext } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { built } from "./built.js";
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
import { setTimeout as sleep } from "node:timers/promises";

import { ApiError, mcpDefinitionSchema } from "@barndog-ai/api-contract";

import { assertCommandAvailable } from "../commands/availability.js";
import { CliError } from "../errors.js";
import { commentOnChange } from "../features/collaboration/index.js";
import { updateCredentials } from "../features/auth/credentials.js";
import { saveSettings } from "../config/settings.js";
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
import { createProgram, type ProgramOptions } from "../program.js";
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
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));

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
  assert(settings?.localWorkspace);

  return { root, home, folder: settings.localWorkspace.path };
}

const quiet = (home: string): AddContext => ({
  home,
  interactive: false,
  write: () => {},
  prompts: {} as AddContext["prompts"],
});

function program(overrides: ProgramOptions = {}) {
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

  expect(await readFile(join(folder, "org/mcp/docs.yaml"), "utf8")).toMatch(
    /command: node/,
  );

  await expect(addMcp('{"command":"node"}', {}, quiet(home))).rejects.toThrow(
    /looks like the configuration/,
  );

  const { instance } = program({});
  const add = instance.commands
    .find((c) => c.name() === "mcp")!
    .commands.find((c) => c.name() === "add")!;

  expect(add.options.some((o) => o.long === "--config")).toBeTruthy();
  expect(add.options.some((o) => o.long === "--json")).toBeFalsy();
});

test("mcp add marks OAuth servers, by flag or from the pasted JSON", () => {
  const server = { name: "docs", server: { url: "https://docs.test/mcp" } };
  expect(
    convertServer(server).definition.authentication,
    "nothing says this server signs in",
  ).toBe("none");

  const flagged = convertServer(server, undefined, true);
  expect(flagged.definition.authentication).toBe("native-oauth");
  expect(flagged.notes.join()).toMatch(/mcp auth docs --origin local/);
  expect(
    convertServer({
      name: "docs",
      server: { url: "https://docs.test/mcp", oauth: { clientId: "x" } },
    }).definition.authentication,
  ).toBe("native-oauth");

  expect(() =>
    convertServer(
      { name: "tool", server: { command: "node" } },
      undefined,
      true,
    ),
  ).toThrow(/only HTTP servers/);
});

test("--json covers review commands and selection changes", async () => {
  const change = [{ id: "1", name: "a", status: "open", revision: 1 }];
  const list = program({ listChanges: async () => change as never });
  await list.instance.parseAsync(["changes", "list", "--json"], {
    from: "user",
  });

  expect(JSON.parse(list.output.join("\n"))).toStrictEqual(change);

  const removed = { status: "applied", events: [] };
  const selection = program({
    changeAsset: async () => removed as never,
  });

  await selection.instance.parseAsync(
    ["skills", "remove", "x", "--origin", "org", "--json"],
    { from: "user" },
  );

  expect(JSON.parse(selection.output.join("\n"))).toStrictEqual(removed);
});

test("failures render as JSON with the same fix people see", () => {
  const error = new CliError("It broke.", "barndog sync");
  expect(JSON.parse(renderJsonError(error))).toStrictEqual({
    error: { message: "It broke.", fix: "barndog sync" },
  });

  expect(
    JSON.parse(
      renderJsonError(new ApiError(403, "X", "PUBLICATION_FORBIDDEN")),
    ),
  ).toStrictEqual({
    error: {
      message:
        "You can't publish here directly. Propose it for review instead.",
      fix: "barndog push",
      status: 403,
    },
  });
});

test("common server refusals carry a Fix line", () => {
  const text = renderError(new ApiError(403, "X", "CHANGE_AUTHOR_REQUIRED"));
  expect(text).toMatch(/Only the author/);
  expect(text).toMatch(/Fix:.*barndog push --new/);
});

test("a change ID from the other list points there", async () => {
  const { instance } = program({
    showChange: async () => {
      throw new ApiError(404, "X", "CHANGE_NOT_FOUND");
    },
  });

  await expect(
    instance.parseAsync(["changes", "show", "abc"], { from: "user" }),
  ).rejects.toSatisfy(
    (error: CliError) =>
      /No Skill/.test(error.message) &&
      error.hint === "barndog hooks changes show abc",
  );
});

test("skills update installs what it changed", async () => {
  let synced = 0;
  const { instance, output } = program({
    updateImported: async () => [{ name: "a", commit: "c1", changes: [] }],
    synchronize: async () => {
      synced += 1;

      return [];
    },
  });

  await instance.parseAsync(["skills", "update"], { from: "user" });
  expect(synced, "nothing changed, so nothing to install").toBe(0);
  const changed = program({
    updateImported: async () => [
      {
        name: "a",
        commit: "c1",
        changes: [
          {
            kind: "modified",
            path: "x",
            patch: "",
            binary: false,
            oldExecutable: false,
            newExecutable: false,
          },
        ],
      },
    ],
    synchronize: async () => {
      synced += 1;

      return [];
    },
  });

  await changed.instance.parseAsync(["skills", "update"], { from: "user" });
  expect(synced).toBe(1);
  expect(plain(changed.output)).toMatch(/Update installed/);
  expect(output.join("").includes("Update installed")).toBe(false);
});

test("status flags a hand-edited install the way sync and doctor do", async (t) => {
  const { root, home, folder } = await localHome(t);
  const installed = await addSkill(root, home);
  const before = (await inventory(home)).items.find((i) => i.name === "review");
  expect(before?.state).toBe("installed");
  await writeFile(join(installed, "SKILL.md"), "edited");
  const after = (await inventory(home)).items.find((i) => i.name === "review");
  expect(after?.state).toBe("modified");
  await expect(synchronize(undefined, home)).rejects.toSatisfy(
    (error: CliError) =>
      /copy that folder somewhere else/.test(error.message) &&
      !/skills pull/.test(error.message),
  );

  expect(folder).toBeTruthy();
});

test("a knowledge file with a bad field is reported, not dropped silently", async (t) => {
  const { home, folder } = await localHome(t);
  await mkdir(join(folder, "org/knowledge"), { recursive: true });
  await writeFile(
    join(folder, "org/knowledge/guide.md"),
    "---\ndescription: Guide\naccess: always\n---\nBody\n",
  );

  const [problem] = await knowledgeProblems(home);
  expect(problem?.path).toBe("org/knowledge/guide.md");
  expect(problem!.reason).toMatch(/access/);
  const events = await synchronize(undefined, home);
  expect(
    events.some(
      (e) => e.type === "notice" && e.message.includes("guide.md was skipped"),
    ),
  ).toBeTruthy();

  expect(
    (await doctor(home)).some((c) => /guide\.md/.test(c.detail)),
  ).toBeTruthy();
});

test("knowledge list reflects whether session-start listing is on", async (t) => {
  const { home, folder } = await localHome(t);
  await mkdir(join(folder, "org/knowledge"), { recursive: true });
  await writeFile(
    join(folder, "org/knowledge/guide.md"),
    "---\ndescription: Guide\naccessMode: always\n---\nBody\n",
  );

  expect((await knowledgeList(false, home))[0]?.listedAtStart).toBe(true);
  const path = join(home, ".barndog/config.yaml");
  await writeFile(path, `${await readFile(path, "utf8")}\nknowledge: false\n`);
  const text = await readFile(path, "utf8");
  await writeFile(
    path,
    `${text.replace(/^knowledge: true\n/m, "").trimEnd()}\n`,
  );

  expect((await knowledgeList(false, home))[0]?.listedAtStart).toBe(false);
  const { instance, output } = program({
    knowledgeList: async () => [
      {
        id: "guide",
        name: "guide",
        description: "Guide",
        tags: [],
        accessMode: "always",
        versionId: "v1",
        version: 1,
        listedAtStart: false,
      },
    ],
    knowledgeProblems: async () => [],
  });

  await instance.parseAsync(["knowledge", "list"], { from: "user" });
  expect(plain(output)).not.toMatch(/every session/);
  expect(plain(output)).toMatch(/barndog knowledge enable/);
});

test("sync doesn't call skipped or stale results up to date", () => {
  const skipped = plain(
    renderSyncOutput([
      { type: "invalid", kind: "skill", name: "bad", reason: "Broken" },
    ]),
  );

  expect(skipped).not.toMatch(/Everything is up to date/);
  expect(skipped).toMatch(/Nothing else changed/);
  const stale = plain(
    renderSyncOutput([{ type: "notice", message: "Can't reach the repo." }]),
  );

  expect(stale).not.toMatch(/Everything is up to date/);
  expect(plain(renderSyncOutput([]))).toMatch(/Everything is up to date/);
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
  expect(quiet).toMatch(/Sync complete · 1 unchanged/);
  expect(quiet).not.toMatch(/knowledge index|workspace sync/);
  const verbose = plain(renderSyncOutput(events, { verbose: true }));
  expect(verbose).toMatch(/Sync complete · 1 unchanged/);
  expect(verbose).toMatch(/knowledge index/);
  expect(verbose).toMatch(/workspace sync/);
  const installed = plain(
    renderSyncOutput([{ ...events[1]!, action: "installed" as const }]),
  );

  expect(installed).not.toMatch(/workspace sync|1 installed/);
  expect(installed).toMatch(/Restart your coding tools/);
});

test("review output uses names and hides noise about new files", () => {
  const diff = (oldExecutable: unknown, newExecutable: unknown) =>
    renderCollaboration([
      { kind: "added", path: "a", patch: "", oldExecutable, newExecutable },
    ]).join("\n");

  expect(diff(null, false)).not.toMatch(/executable/);
  expect(diff(null, true)).toMatch(/executable/);
  expect(diff(false, true)).toMatch(/executable: false → true/);
  const [row] = renderCollaboration([
    {
      number: 2,
      commit: "abc",
      description: "Second",
      publishedBy: "uuid-1",
      publisherName: "Alice Doe",
    },
  ]);

  expect(row!).toMatch(/published by Alice Doe/);
  expect(row!).not.toMatch(/uuid-1/);
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

  expect(text).toMatch(/v3/);
  expect(text).toMatch(/node server\.js/);
  expect(text).toMatch(/E2E_MCP_TOKEN from \$E2E_MCP_TOKEN/);
  expect(text).not.toMatch(/\[object|E2e mcp/);
  expect(plain(renderValue({ E2E_MCP_TOKEN: "x" }))).toMatch(/E2E_MCP_TOKEN/);
});

test("a comment's text files drop their closing newline unless the range ends on an empty line", async (t) => {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "barndog-comment-")),
  );

  const organization = { id: randomUUID(), slug: "local", name: "Local" };
  const developer = {
    id: randomUUID(),
    slug: "admin",
    name: "Admin",
    role: "organization_admin" as const,
  };

  const server = "http://127.0.0.1:9";
  await saveSettings(
    {
      harnesses: [],
      connection: {
        server,
        organizationId: organization.id,
        developerId: developer.id,
      },
    },
    home,
  );

  await updateCredentials(home, (credentials) => {
    credentials.servers[server] = {
      token: "a".repeat(43),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      context: { organization, developer },
    };
  });

  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    if (request.method === "POST") {
      bodies.push(await request.json());
    }

    return Response.json({ organization, developer });
  });

  t.onTestFinished(async () => {
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  });

  const file = async (name: string, text: string) => {
    await writeFile(join(home, name), text);

    return join(home, name);
  };

  const comment = async (expected: string, lines: number) =>
    commentOnChange(
      {
        kind: "skill",
        id: randomUUID(),
        revision: 1,
        body: "Suggestion",
        path: "SKILL.md",
        side: "new",
        startLine: 1,
        endLine: lines,
        replacementFile: await file("replacement.txt", "new\n"),
        expectedFile: await file("expected.txt", expected),
      },
      home,
    );

  await comment("one\ntwo\n", 2);
  await comment("one\ntwo", 2);
  await comment("one\n", 2);
  expect(
    bodies.map(({ replacement, expectedContent }) => [
      replacement,
      expectedContent,
    ]),
  ).toStrictEqual([
    ["new", "one\ntwo"],
    ["new", "one\ntwo"],
    ["new", "one\n"],
  ]);
});

test("assets install accepts override decisions", async () => {
  let seen: Record<string, unknown> = {};
  const { instance } = program({
    changeAsset: async (_, target) => {
      seen = target;

      return { status: "applied", events: [] };
    },
  });

  await instance.parseAsync(
    ["skills", "install", "x", "--origin", "org", "--overrides", "preserve"],
    { from: "user" },
  );

  expect(seen.overrides).toBe("preserve");
});

test("an unavailable command says so before asking for its flags", async (t) => {
  const { home } = await localHome(t);
  const { instance } = program({
    guard: (path, options) => assertCommandAvailable(path, options, home),
  });

  await expect(
    instance.parseAsync(["mcp", "create", "x"], { from: "user" }),
  ).rejects.toThrow(/needs a BarnDog Cloud Workspace/);
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

  expect("env_http_headers" in entry.value).toBe(false);
});

test("a missing path is reported as missing, not as something to clone", () => {
  expect(() => assertSourceExists("/missing/path")).toThrow(/Can't find/);
  expect(() => assertSourceExists("github.com/acme/skills")).not.toThrow();
  expect(() => assertSourceExists("https://x.test/a.git")).not.toThrow();
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

  expect(existsSync(join(home, ".barndog/workspace"))).toBe(false);
  expect(existsSync(join(home, ".barndog/sync.lock"))).toBe(false);
});

test("a stopped process releases the environment lock", async (t) => {
  const home = join(await temp(t), "home");
  const transaction = built("features/environment/transaction.js");
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
  for (let i = 0; i < 200 && !existsSync(join(lock, "pid")); i++) {
    await sleep(25);
  }

  expect(existsSync(join(lock, "pid"))).toBe(true);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
  expect(existsSync(lock)).toBe(false);
});
