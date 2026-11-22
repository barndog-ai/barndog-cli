import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { assert, expect, test, type TestContext } from "vitest";

import type { McpDefinition } from "@barndog-ai/api-contract";
import { readSettings } from "../config/settings.js";
import { readState } from "../config/state.js";
import { CliError } from "../errors.js";
import { adoptNative } from "../features/adoption/adopt.js";
import {
  hookCommand,
  movedHookCommand,
} from "../features/native/hook-shell.js";
import type { UninstallResult } from "../features/uninstall/index.js";
import { mcpVariables } from "../features/uninstall/survey.js";
import { adapters } from "../harnesses/registry.js";
import { directoryLinkType } from "../platform.js";
import { createProgram } from "../program.js";
import { runSetup } from "../ui/onboarding.js";
import { cloud } from "./cloud.js";
import { testRuntime } from "./runtime.js";

async function write(root: string, path: string, text: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

const json = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8"));

/**
 * A machine with a local folder for Claude Code, where BarnDog adopted a
 * Skill, an MCP server and a Hook the tool had.
 */
async function adopted(t: TestContext) {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "barndog-uninstall-")),
  );

  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const runtime = testRuntime(home);

  await runSetup({
    runtime,
    local: true,
    restart: true,
    interactive: true,
    detected: [],
    write: () => {},
    confirmRestart: async () => true,
    confirmApply: async () => true,
    choose: async () => ["claude"],
  });

  await write(
    home,
    ".claude/skills/notes/SKILL.md",
    "---\nname: notes\ndescription: Notes\n---\n\nTake notes.\n",
  );

  await write(home, ".claude/skills/notes/refs/tip.md", "Tip\n");
  await write(
    home,
    ".claude.json",
    JSON.stringify({ mcpServers: { github: { command: "npx" } } }),
  );

  await write(home, ".claude/hooks/check.sh", "#!/bin/sh\necho checked\n");
  const settingsFile = join(home, ".claude/settings.json");
  const existing = (await json(settingsFile)) as {
    hooks: Record<string, unknown[]>;
  };

  await write(
    home,
    ".claude/settings.json",
    JSON.stringify({
      ...existing,
      hooks: {
        ...existing.hooks,
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "sh ~/.claude/hooks/check.sh" },
            ],
          },
        ],
      },
    }),
  );

  await adoptNative(
    ["claude/skill/notes", "claude/mcp/github", "claude/hook/check"],
    [],
    runtime,
  );

  return { home, runtime };
}

async function command(home: string, args: string[]) {
  const output: string[] = [];
  const failure = await createProgram({
    home,
    interactive: false,
    write: (text) => output.push(text),
    writeError: (text) => output.push(text),
  })
    .parseAsync(args, { from: "user" })
    .then(() => undefined)
    .catch((error: unknown) => error);

  return { output, failure };
}

type ClaudeSettings = {
  hooks?: Record<string, { hooks: { command: string }[] }[]>;
};

test("uninstall --keep-setup leaves Skills, MCP servers and Hooks working without BarnDog", async (t) => {
  const { home } = await adopted(t);
  const settingsFile = join(home, ".claude/settings.json");
  expect(await readFile(settingsFile, "utf8")).toContain("workspace-startup");

  const { output, failure } = await command(home, [
    "uninstall",
    "--keep-setup",
    "--json",
  ]);

  expect(failure).toBeUndefined();
  const result = JSON.parse(output.join("")) as UninstallResult;
  expect(result.left.map((asset) => [asset.kind, asset.name])).toStrictEqual([
    ["skill", "notes"],
    ["hook", expect.any(String)],
  ]);

  // The Skill is a folder of the tool's own now, not a link into ~/.barndog.
  const skill = join(home, ".claude/skills/notes");
  expect((await lstat(skill)).isDirectory()).toBe(true);
  expect(await readFile(join(skill, "refs/tip.md"), "utf8")).toBe("Tip\n");

  expect(await json(join(home, ".claude.json"))).toMatchObject({
    mcpServers: { github: { command: "npx" } },
  });

  const text = await readFile(settingsFile, "utf8");
  expect(text).not.toContain("workspace-startup");
  expect(text).not.toContain(".barndog");

  const hookFolder = result.left.find((asset) => asset.kind === "hook")?.path;
  assert(hookFolder);
  expect(dirname(hookFolder)).toBe(join(home, ".claude/hooks"));

  const settings = (await json(settingsFile)) as ClaudeSettings;
  const hookCommand = settings.hooks?.PreToolUse?.[0]?.hooks[0]?.command;
  assert(hookCommand);
  expect(hookCommand).toContain(hookFolder);

  if (process.platform !== "win32") {
    const run = spawnSync("/bin/sh", ["-c", hookCommand], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });

    expect(run.stdout).toBe("checked\n");
  }

  // Only the local workspace is kept, and it still holds the adopted copies.
  expect(await readdir(join(home, ".barndog"))).toStrictEqual(["workspace"]);
  expect(result.keptWorkspace).toBe(join(home, ".barndog/workspace"));

  const again = await command(home, ["uninstall", "--keep-setup"]);
  expect(again.failure).toBeUndefined();
});

test("uninstall --remove-all puts adopted assets back and deletes ~/.barndog", async (t) => {
  const { home } = await adopted(t);

  const { output, failure } = await command(home, [
    "uninstall",
    "--remove-all",
    "--remove-workspace",
  ]);

  expect(failure).toBeUndefined();
  expect(output.join("\n")).toMatch(
    /Removed everything BarnDog installed[\s\S]*Put back[\s\S]*npm uninstall -g barndog/,
  );

  const skill = join(home, ".claude/skills/notes");
  expect((await lstat(skill)).isDirectory()).toBe(true);
  expect(await json(join(home, ".claude.json"))).toMatchObject({
    mcpServers: { github: { command: "npx" } },
  });

  const settings = (await json(
    join(home, ".claude/settings.json"),
  )) as ClaudeSettings;

  expect(settings.hooks?.PreToolUse?.[0]?.hooks[0]?.command).toBe(
    "sh ~/.claude/hooks/check.sh",
  );

  expect(JSON.stringify(settings)).not.toContain("workspace-startup");
  await expect(lstat(join(home, ".barndog"))).rejects.toThrow();
});

test("uninstall --remove-all --drop-adopted removes adopted assets for good", async (t) => {
  const { home } = await adopted(t);

  const { failure } = await command(home, [
    "uninstall",
    "--remove-all",
    "--drop-adopted",
  ]);

  expect(failure).toBeUndefined();
  await expect(lstat(join(home, ".claude/skills/notes"))).rejects.toThrow();
  expect(await json(join(home, ".claude.json"))).toStrictEqual({
    mcpServers: {},
  });

  const settings = (await json(
    join(home, ".claude/settings.json"),
  )) as ClaudeSettings;

  expect(settings.hooks?.PreToolUse ?? []).toStrictEqual([]);
});

test("uninstall needs a choice without a terminal, and --dry-run changes nothing", async (t) => {
  const { home } = await adopted(t);

  const missing = await command(home, ["uninstall"]);
  expect(missing.failure).toBeInstanceOf(CliError);
  expect(missing.failure).toMatchObject({
    hint: "barndog uninstall --keep-setup",
  });

  const both = await command(home, [
    "uninstall",
    "--keep-setup",
    "--remove-all",
  ]);

  expect(both.failure).toBeDefined();

  const before = await readFile(join(home, ".claude/settings.json"), "utf8");
  const dry = await command(home, ["uninstall", "--remove-all", "--dry-run"]);
  expect(dry.failure).toBeUndefined();
  expect(dry.output.join("\n")).toMatch(
    /remove 1 Skill, 1 MCP server and 1 Hook[\s\S]*put back 3 adopted assets/,
  );

  expect(await readFile(join(home, ".claude/settings.json"), "utf8")).toBe(
    before,
  );

  expect(await readSettings(home)).not.toBeNull();
});

test("uninstall signs out of the server and revokes the session", async (t) => {
  const server = await cloud(t);

  await server.run(["uninstall", "--remove-all", "--json"]);
  expect(server.requests).toContain("DELETE /v1/auth/cli/session");
  await expect(lstat(join(server.home, ".barndog"))).rejects.toThrow();
});

test("a Hook command moves to a new folder only when BarnDog wrote it", () => {
  const written = "export BARNDOG_HOOK_ROOT='/a' CLAUDE_PLUGIN_ROOT='/a'; x";
  expect(
    movedHookCommand(written, { from: "/a", to: "/b c" }, "claude", "linux"),
  ).toBe("export BARNDOG_HOOK_ROOT='/b c' CLAUDE_PLUGIN_ROOT='/b c'; x");

  expect(
    movedHookCommand("echo hi", { from: "/a", to: "/b" }, "claude", "linux"),
  ).toBeUndefined();

  const windows = (root: string) => hookCommand(root, "x", "cursor", "win32");

  expect(
    movedHookCommand(
      windows("C:\\a"),
      { from: "C:\\a", to: "C:\\b" },
      "cursor",
      "win32",
    ),
  ).toBe(windows("C:\\b"));
});

test("uninstall passes its options to the workflow", async () => {
  const calls: unknown[] = [];
  const run = (args: string[]) =>
    createProgram({
      interactive: false,
      write: () => {},
      uninstallSurvey: async () => ({
        root: "/home/.barndog",
        installed: [],
        adopted: [
          {
            key: "claude/mcp/github",
            harness: "claude",
            kind: "mcp",
            name: "github",
            description: "",
            location: "/home/.claude.json",
            copy: "/home/.barndog/workspace/mcp/github.json",
            undone: false,
          },
        ],
        servers: [],
        variables: [],
      }),
      uninstall: async (options) => {
        calls.push(options);

        return {
          keptSetup: true,
          left: [],
          removed: [],
          variables: [],
          restored: [],
          signedOut: [],
          root: "/r",
        };
      },
    }).parseAsync(["uninstall", ...args], { from: "user" });

  await run(["--keep-setup"]);
  await run(["--remove-all"]);
  await run([
    "--remove-all",
    "--drop-adopted",
    "--remove-workspace",
    "--force",
  ]);

  await run(["--remove-all", "--dry-run"]);

  expect(calls).toStrictEqual([
    { keepSetup: true, restore: [], keepWorkspace: true, force: undefined },
    {
      keepSetup: false,
      restore: ["claude/mcp/github"],
      keepWorkspace: true,
      force: undefined,
    },
    { keepSetup: false, restore: [], keepWorkspace: false, force: true },
  ]);
});

test("uninstall --keep-setup stops before changing anything when a destination is taken", async (t) => {
  const { home } = await adopted(t);
  const settingsFile = join(home, ".claude/settings.json");
  const before = await readFile(settingsFile, "utf8");

  const hook = (await readState(home)).installed.find(
    (entry) => entry.kind === "hook",
  );

  assert(hook);
  const destination = join(home, ".claude/hooks", basename(hook.path));
  await write(destination, "other.sh", "mine\n");
  const taken = await command(home, ["uninstall", "--keep-setup"]);
  expect(taken.failure).toBeInstanceOf(CliError);
  expect((taken.failure as CliError).message).toMatch(/already exists/);
  expect(await readFile(settingsFile, "utf8")).toBe(before);
  expect(
    (await lstat(join(home, ".claude/skills/notes"))).isSymbolicLink(),
  ).toBe(true);

  await rm(destination, { recursive: true });
  await rm(join(home, ".claude/skills/notes"));
  await symlink(
    join(home, "elsewhere"),
    join(home, ".claude/skills/notes"),
    directoryLinkType(process.platform),
  );

  const moved = await command(home, ["uninstall", "--keep-setup"]);
  expect((moved.failure as CliError).message).toMatch(
    /changed outside BarnDog/,
  );
});

test("the variables kept MCP servers read, each once, leaving out values written into an entry", () => {
  const github: McpDefinition = {
    description: "GitHub",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    environment: {
      GITHUB_PERSONAL_ACCESS_TOKEN: { secretRef: "GITHUB_TOKEN" },
      API_KEY: { secretRef: "SAVED_KEY" },
    },
    authentication: "environment",
  };

  const entry = (harness: "claude" | "codex" | "cursor", key: string) => ({
    id: key,
    kind: "mcp" as const,
    harness,
    file: `/home/${harness}`,
    key,
    value: adapters[harness].mcp.server(
      github,
      { SAVED_KEY: "sk-saved" },
      "linux",
    ),
  });

  const docs = {
    ...entry("cursor", "docs"),
    value: adapters.cursor.mcp.server(
      {
        description: "Docs",
        transport: "http",
        url: "https://docs.example/mcp",
        headers: { Authorization: { secretRef: "DOCS_TOKEN" } },
        authentication: "environment",
      },
      {},
      "linux",
    ),
  };

  expect(
    mcpVariables({
      version: 1,
      links: [],
      installed: [],
      native: [
        entry("claude", "github"),
        entry("codex", "github"),
        entry("cursor", "github-copy"),
        docs,
        { ...entry("claude", "broken"), value: { type: "sse" } },
      ],
    }),
  ).toStrictEqual([
    { name: "GITHUB_TOKEN", servers: ["github", "github-copy"] },
    { name: "DOCS_TOKEN", servers: ["docs"] },
  ]);
});
