import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assert, expect, test, type TestContext } from "vitest";

import { readSettings, saveSettings } from "../config/settings.js";
import { readState } from "../config/state.js";
import { CliError } from "../errors.js";
import { adoptNative, adoptionPlan } from "../features/adoption/adopt.js";
import {
  listAdoptions,
  readAdoptions,
  writeAdoption,
} from "../features/adoption/record.js";
import { undoAdoption } from "../features/adoption/undo.js";
import { directoryLinkType } from "../platform.js";
import { scanNative } from "../features/adoption/scan.js";
import { readStoredSecrets } from "../features/secrets/index.js";
import type { Harness } from "../harnesses/registry.js";
import { createProgram } from "../program.js";
import { runSetup } from "../ui/onboarding.js";
import { testRuntime } from "./runtime.js";

async function temp(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "barndog-adopt-")));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));

  return root;
}

async function write(root: string, path: string, text: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

const json = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8"));

const skill = (name: string, body = "Do the thing.") =>
  `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}\n`;

/** A machine set up with a local folder, before any tool has assets. */
async function machine(
  t: TestContext,
  harnesses: Harness[] = ["claude", "cursor"],
) {
  const home = await temp(t);
  await runSetup({
    runtime: testRuntime(home),
    local: true,
    restart: true,
    interactive: true,
    detected: [],
    write: () => {},
    confirmRestart: async () => true,
    confirmApply: async () => true,
    choose: async () => harnesses,
  });

  const settings = await readSettings(home);
  assert(settings?.localWorkspace);

  return {
    home,
    folder: settings.localWorkspace.path,
    runtime: testRuntime(home),
  };
}

/** Each tool's own assets, written the way the tools keep them. */
async function toolAssets(home: string) {
  await write(home, ".claude/skills/notes/SKILL.md", skill("notes"));
  await write(home, ".claude/skills/notes/refs/tip.md", "Tip\n");
  await write(home, "elsewhere/linked/SKILL.md", skill("linked"));
  await mkdir(join(home, ".cursor/skills"), { recursive: true });
  await symlink(
    join(home, "elsewhere/linked"),
    join(home, ".cursor/skills/linked"),
    directoryLinkType(process.platform),
  );

  await write(
    home,
    ".claude.json",
    JSON.stringify({
      mcpServers: {
        github: { command: "npx", args: ["github-mcp"] },
        lonely: { command: "lonely" },
      },
      theme: "dark",
    }),
  );

  await write(
    home,
    ".cursor/mcp.json",
    JSON.stringify({
      mcpServers: { github: { command: "npx", args: ["github-mcp"] } },
    }),
  );

  await write(home, ".claude/hooks/check.sh", "#!/bin/sh\necho checked\n");
  await write(home, ".claude/hooks/done.sh", "#!/bin/sh\necho done\n");
  // Setup may already have put BarnDog's own session-start entry here.
  const settingsFile = join(home, ".claude/settings.json");
  const existing = (await readFile(settingsFile, "utf8").then(
    (text) => JSON.parse(text) as { hooks?: Record<string, unknown[]> },
    () => ({}),
  )) as { hooks?: Record<string, unknown[]> };

  await write(
    home,
    ".claude/settings.json",
    JSON.stringify({
      ...existing,
      model: "opus",
      hooks: {
        ...existing.hooks,
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "$HOME/.claude/hooks/check.sh" },
            ],
          },
        ],
        Stop: [
          { hooks: [{ type: "command", command: "~/.claude/hooks/done.sh" }] },
        ],
      },
    }),
  );
}

test("a scan lists each tool's own assets and skips what BarnDog installed", async (t) => {
  const { home, runtime } = await machine(t);
  await toolAssets(home);
  await write(home, ".claude/skills/Bad Name/SKILL.md", skill("bad"));

  const scan = await scanNative(runtime);
  const keys = scan.assets.map((asset) => asset.key).sort();

  expect(keys).toStrictEqual([
    "claude/hook/check",
    "claude/hook/done",
    "claude/mcp/github",
    "claude/mcp/lonely",
    "claude/skill/notes",
    "cursor/mcp/github",
    "cursor/skill/linked",
  ]);

  const github = scan.assets.find((asset) => asset.key === "claude/mcp/github");
  expect(github?.sameName).toStrictEqual([
    { key: "cursor/mcp/github", harness: "cursor" },
  ]);

  expect(github?.identical).toBe(true);
  expect(scan.skipped.map((s) => [s.name, s.reason])).toStrictEqual([
    ["Bad Name", expect.stringMatching(/can't be a BarnDog name/)],
  ]);

  // BarnDog's own session-start entry is in settings.json and isn't offered.
  expect(scan.assets.some((asset) => asset.name.includes("sync"))).toBe(false);
});

test("adopting moves the chosen assets to BarnDog and undo puts them back", async (t) => {
  const { home, folder, runtime } = await machine(t);
  await toolAssets(home);
  const claudeSettings = await json(join(home, ".claude/settings.json"));

  const result = await adoptNative(
    [
      "claude/skill/notes",
      "cursor/skill/linked",
      "claude/mcp/github",
      "claude/hook/check",
    ],
    [],
    runtime,
  );

  // Cursor's identical github comes along: BarnDog installs one copy everywhere.
  expect(result.adopted.map((asset) => asset.key).sort()).toStrictEqual([
    "claude/hook/check",
    "claude/mcp/github",
    "claude/skill/notes",
    "cursor/mcp/github",
    "cursor/skill/linked",
  ]);

  // Copies in the local folder.
  expect(
    await readFile(join(folder, "org/skills/notes/refs/tip.md"), "utf8"),
  ).toBe("Tip\n");

  expect(await readFile(join(folder, "org/mcp/github.yaml"), "utf8")).toMatch(
    /github-mcp/,
  );

  expect(
    await readFile(join(folder, "org/hooks/check/check.sh"), "utf8"),
  ).toMatch(/checked/);

  // BarnDog's links replace the tools' own; the linked Skill's target is untouched.
  const state = await readState(home);
  const links = state.links.map((link) => link.target).sort();
  expect(links).toContain(join(home, ".claude/skills/notes"));
  expect(links).toContain(join(home, ".cursor/skills/linked"));
  expect(await readFile(join(home, "elsewhere/linked/SKILL.md"), "utf8")).toBe(
    skill("linked"),
  );

  expect(await realpath(join(home, ".cursor/skills/linked"))).not.toBe(
    join(home, "elsewhere/linked"),
  );

  // The unchosen MCP server and hook stay as they were.
  const claude = await json(join(home, ".claude.json"));
  assert(typeof claude === "object" && claude);
  expect(claude).toMatchObject({
    mcpServers: { lonely: { command: "lonely" } },
    theme: "dark",
  });

  const settings = JSON.stringify(
    await json(join(home, ".claude/settings.json")),
  );

  expect(settings).toContain("~/.claude/hooks/done.sh");
  expect(settings).not.toContain("$HOME/.claude/hooks/check.sh");

  // Nothing BarnDog now manages is offered again.
  expect(
    (await scanNative(runtime)).assets.map((a) => a.key).sort(),
  ).toStrictEqual(["claude/hook/done", "claude/mcp/lonely"]);

  const undone = await undoAdoption({}, runtime);
  expect(undone.remaining).toStrictEqual([]);
  expect(
    await readFile(join(home, ".claude/skills/notes/refs/tip.md"), "utf8"),
  ).toBe("Tip\n");

  expect(await realpath(join(home, ".cursor/skills/linked"))).toBe(
    join(home, "elsewhere/linked"),
  );

  expect(await json(join(home, ".cursor/mcp.json"))).toStrictEqual({
    mcpServers: { github: { command: "npx", args: ["github-mcp"] } },
  });

  expect(await json(join(home, ".claude.json"))).toMatchObject({
    mcpServers: {
      github: { command: "npx", args: ["github-mcp"] },
      lonely: { command: "lonely" },
    },
  });

  const restored = await json(join(home, ".claude/settings.json"));
  expect(restored).toMatchObject({
    model: "opus",
    hooks: {
      PreToolUse: [
        claudeSettings &&
          (claudeSettings as { hooks: { PreToolUse: unknown[] } }).hooks
            .PreToolUse[0],
      ],
    },
  });

  await expect(lstat(join(folder, "org/skills/notes"))).rejects.toThrow();
  expect((await readAdoptions(home))[0]?.status).toBe("undone");
  await expect(undoAdoption({}, runtime)).rejects.toThrow(/nothing to undo/);
});

test("undo can put back part of an adoption", async (t) => {
  const { home, runtime } = await machine(t);
  await toolAssets(home);
  const { id } = await adoptNative(
    ["claude/mcp/github", "claude/mcp/lonely"],
    [],
    runtime,
  );

  // Asking for one tool's github brings back every copy that shares its name.
  const result = await undoAdoption(
    { id, only: ["claude/mcp/github"] },
    runtime,
  );

  expect(result.restored.map((item) => item.key).sort()).toStrictEqual([
    "claude/mcp/github",
    "cursor/mcp/github",
  ]);

  expect(result.remaining.map((item) => item.key)).toStrictEqual([
    "claude/mcp/lonely",
  ]);

  expect((await readAdoptions(home))[0]?.status).toBe("applied");

  await expect(
    undoAdoption({ id, only: ["claude/mcp/github"] }, runtime),
  ).rejects.toThrow(/nothing to undo for claude\/mcp\/github/);
});

test("undo keeps edits made to BarnDog's copy unless forced", async (t) => {
  const { home, folder, runtime } = await machine(t);
  await toolAssets(home);
  const { id } = await adoptNative(["claude/skill/notes"], [], runtime);
  await writeFile(
    join(folder, "org/skills/notes/SKILL.md"),
    skill("notes", "Edited."),
  );

  await expect(undoAdoption({ id }, runtime)).rejects.toSatisfy(
    (error: CliError) =>
      error.message.includes("changed since notes was adopted") &&
      error.command === `barndog adopt undo ${id} --force`,
  );

  await undoAdoption({ id, force: true }, runtime);
  expect(
    await readFile(join(home, ".claude/skills/notes/SKILL.md"), "utf8"),
  ).toBe(skill("notes"));
});

test("an adoption that stopped halfway blocks the next one until undone", async (t) => {
  const { home, runtime } = await machine(t);
  await toolAssets(home);
  await adoptNative(["claude/skill/notes", "claude/mcp/lonely"], [], runtime);

  // As if the process died after taking the originals out.
  const [record] = await readAdoptions(home);
  assert(record);
  await writeAdoption({ ...record, status: "pending" }, home);

  await expect(
    adoptNative(["claude/hook/done"], [], runtime),
  ).rejects.toSatisfy(
    (error: CliError) => error.hint === `barndog adopt undo ${record.id}`,
  );

  await expect(
    undoAdoption({ id: record.id, only: ["claude/mcp/lonely"] }, runtime),
  ).rejects.toThrow(/only be undone as a whole/);

  await undoAdoption({ id: record.id }, runtime);
  expect(
    await readFile(join(home, ".claude/skills/notes/SKILL.md"), "utf8"),
  ).toBe(skill("notes"));

  expect(await json(join(home, ".claude.json"))).toMatchObject({
    mcpServers: { lonely: { command: "lonely" } },
  });
});

test("a failed adoption puts everything back", async (t) => {
  const { home, folder, runtime } = await machine(t);
  await toolAssets(home);
  // Cursor holds a folder named notes that isn't a Skill, so the sync that
  // installs BarnDog's copy there refuses, after the original was moved.
  await mkdir(join(home, ".cursor/skills/notes"), { recursive: true });
  await write(home, ".cursor/skills/notes/readme.txt", "mine");

  await expect(
    adoptNative(["claude/skill/notes"], [], runtime),
  ).rejects.toThrow(/didn't install/);

  expect(
    await readFile(join(home, ".claude/skills/notes/SKILL.md"), "utf8"),
  ).toBe(skill("notes"));

  await expect(lstat(join(folder, "org/skills/notes"))).rejects.toThrow();
  expect((await readAdoptions(home))[0]?.status).toBe("undone");
});

test("a plan refuses unknown assets and two different copies of one name", async (t) => {
  const { home, runtime } = await machine(t);
  await toolAssets(home);
  await write(
    home,
    ".cursor/mcp.json",
    JSON.stringify({ mcpServers: { github: { command: "other" } } }),
  );

  const scan = await scanNative(runtime);
  expect(() => adoptionPlan(scan, ["claude/mcp/nope"])).toThrow(
    /isn't an asset/,
  );

  expect(() =>
    adoptionPlan(scan, ["claude/mcp/github", "cursor/mcp/github"]),
  ).toThrow(/different MCP servers with the same name/);

  const plan = adoptionPlan(scan, ["claude/mcp/github"]);
  expect(plan.map((asset) => [asset.key, asset.source.key])).toStrictEqual([
    ["claude/mcp/github", "claude/mcp/github"],
    ["cursor/mcp/github", "claude/mcp/github"],
  ]);
});

test("first-time setup offers to adopt what the tools already have", async (t) => {
  const home = await temp(t);
  await toolAssets(home);
  let offered: string[] = [];
  const output: string[] = [];

  await runSetup({
    runtime: testRuntime(home),
    local: true,
    interactive: true,
    detected: [],
    write: (line) => output.push(line),
    confirmApply: async () => true,
    choose: async () => ["claude"],
    chooseAdoption: async (scan) => {
      offered = scan.assets.map((asset) => asset.key);

      return ["claude/skill/notes"];
    },
    confirmAdoption: async () => true,
  });

  // Cursor isn't managed, so its assets aren't offered.
  expect(offered.every((key) => key.startsWith("claude/"))).toBe(true);
  expect(output.join("\n")).toMatch(/Adopted 1 asset/);
  const state = await readState(home);
  expect(state.links.map((link) => link.target)).toContain(
    join(home, ".claude/skills/notes"),
  );
});

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

test("adopt commands list, adopt and undo without a terminal", async (t) => {
  const { home } = await machine(t);
  await toolAssets(home);

  const dry = await command(home, ["adopt", "--dry-run", "--json"]);
  expect(dry.failure).toBeUndefined();
  expect(JSON.parse(dry.output.join(""))).toMatchObject({
    assets: expect.arrayContaining([
      expect.objectContaining({ key: "claude/mcp/lonely" }),
    ]),
  });

  const human = await command(home, ["adopt", "--dry-run"]);
  expect(human.output.join("\n")).toMatch(
    /Claude Code[\s\S]*lonely[\s\S]*Cursor/,
  );

  const missing = await command(home, ["adopt"]);
  expect(missing.failure).toBeInstanceOf(CliError);
  expect(missing.failure).toMatchObject({
    message: expect.stringMatching(/--only/),
    hint: "barndog adopt --dry-run",
  });

  const both = await command(home, ["adopt", "--all", "--only", "x"]);
  expect((both.failure as CliError).message).toMatch(/can't be combined/);

  const adopted = await command(home, [
    "adopt",
    "--only",
    "claude/mcp/lonely",
    "--json",
  ]);

  expect(adopted.failure).toBeUndefined();
  const { id } = JSON.parse(adopted.output.join("")) as { id: string };

  const listed = await command(home, ["adopt", "list"]);
  expect(listed.output.join("\n")).toContain(id);

  const undone = await command(home, ["adopt", "undo", id]);
  expect(undone.failure).toBeUndefined();
  expect(undone.output.join("\n")).toMatch(/Put back 1 asset/);

  const unknown = await command(home, ["adopt", "undo", "../../etc"]);
  expect((unknown.failure as CliError).message).toMatch(/no adoption/);
});

test("adopt passes its options to the adoption functions", async () => {
  const calls: unknown[] = [];
  const program = () =>
    createProgram({
      interactive: false,
      write: () => {},
      scanNative: async () => ({
        assets: [
          {
            key: "codex/skill/a",
            harness: "codex",
            kind: "skill",
            name: "a",
            description: "A",
            location: "/x",
            sameName: [],
            identical: true,
            notes: [],
            values: [],
          },
        ],
        skipped: [],
      }),
      adoptNative: async (keys) => {
        calls.push(["adopt", keys]);

        return {
          id: "i",
          adopted: [],
          backup: "/b",
          notes: [],
          values: [],
          events: [],
          canShare: false,
        };
      },
      undoAdoption: async (target) => {
        calls.push(["undo", target]);

        return { id: "i", restored: [], remaining: [] };
      },
      listAdoptions: async () => [],
    });

  await program().parseAsync(["adopt", "--all"], { from: "user" });
  await program().parseAsync(["adopt", "--only", "x", "y"], { from: "user" });
  await program().parseAsync(["adopt", "undo"], { from: "user" });
  await program().parseAsync(
    ["adopt", "undo", "id", "--only", "x", "--force"],
    { from: "user" },
  );

  expect(calls).toStrictEqual([
    ["adopt", ["codex/skill/a"]],
    ["adopt", ["x", "y"]],
    ["undo", { id: undefined, only: undefined, force: undefined }],
    ["undo", { id: "id", only: ["x"], force: true }],
  ]);
});

test("a scan explains what it can't adopt and keeps Hook names apart", async (t) => {
  const { home, folder, runtime } = await machine(t, [
    "claude",
    "codex",
    "cursor",
    "opencode",
  ]);

  // A Skill whose link points nowhere, and one that isn't valid.
  await mkdir(join(home, ".claude/skills"), { recursive: true });
  await symlink(
    join(home, "gone"),
    join(home, ".claude/skills/dangling"),
    directoryLinkType(process.platform),
  );

  await write(home, ".claude/skills/broken/SKILL.md", "no front matter\n");
  // The local folder already has a Skill and a Hook with these names.
  await write(home, ".claude/skills/taken/SKILL.md", skill("taken"));
  await write(folder, "org/skills/taken/SKILL.md", skill("taken"));
  await write(folder, "org/hooks/check/hook.yaml", "name: check\n");
  await write(
    folder,
    "org/mcp/docs.yaml",
    "transport: stdio\ncommand: d\nargs: []\nenvironment: {}\ndescription: Docs\nauthentication: none\n",
  );

  // MCP servers: a bad name, a transport BarnDog can't hold, and one name in two OpenCode files.
  await write(
    home,
    ".claude.json",
    JSON.stringify({
      mcpServers: {
        "Bad.Name": { command: "x" },
        streaming: { type: "sse", url: "https://example.com/sse" },
        // The standard format is kept; only a case-only twin of a local one is refused.
        My_Server: { command: "m" },
        DOCS: { command: "d" },
      },
    }),
  );

  await write(
    home,
    ".config/opencode/opencode.jsonc",
    JSON.stringify({
      mcp: { servers: { twin: { type: "local", command: ["a"] } } },
    }),
  );

  await write(
    home,
    ".config/opencode/opencode.json",
    JSON.stringify({
      mcp: { servers: { twin: { type: "local", command: ["b"] } } },
    }),
  );

  // Hooks in three tools: same script name twice, duplicates, a prompt hook,
  // two different scripts with one name, and settings a Hook can't hold.
  await write(home, "one/check.sh", "#!/bin/sh\necho one\n");
  await write(home, "two/check.sh", "#!/bin/sh\necho two\n");
  // A script, so Windows (which adopts only hooks that run one) reaches the
  // settings check too.
  await write(home, "three/extra.sh", "#!/bin/sh\necho extra\n");
  const settingsFile = join(home, ".claude/settings.json");
  const existing = JSON.parse(await readFile(settingsFile, "utf8")) as {
    hooks: Record<string, unknown[]>;
  };

  const twice = { hooks: [{ type: "command", command: "echo twice" }] };
  await write(
    home,
    ".claude/settings.json",
    JSON.stringify({
      ...existing,
      hooks: {
        ...existing.hooks,
        PreToolUse: [
          { hooks: [{ type: "command", command: `${home}/one/check.sh` }] },
        ],
        PostToolUse: [twice, twice],
        Stop: [{ hooks: [{ type: "prompt", prompt: "Check it" }] }],
        Notification: [
          {
            hooks: [
              { type: "command", command: `${home}/one/check.sh` },
              { type: "command", command: `${home}/two/check.sh` },
            ],
          },
        ],
        SubagentStop: [
          {
            hooks: [
              {
                type: "command",
                command: `${home}/three/extra.sh`,
                extra: true,
              },
            ],
          },
        ],
        Odd: "not a list",
      },
    }),
  );

  const cursorFile = join(home, ".cursor/hooks.json");
  const cursor = JSON.parse(await readFile(cursorFile, "utf8")) as {
    hooks: Record<string, unknown[]>;
  };

  await write(
    home,
    ".cursor/hooks.json",
    JSON.stringify({
      ...cursor,
      hooks: {
        ...cursor.hooks,
        beforeShellExecution: [{ command: `${home}/two/check.sh` }],
      },
    }),
  );

  const scan = await scanNative(runtime);
  const reasons = Object.fromEntries(
    scan.skipped.map((s) => [`${s.harness}/${s.kind}/${s.name}`, s.reason]),
  );

  expect(reasons).toMatchObject({
    "claude/skill/dangling": expect.stringMatching(/doesn't exist/),
    "claude/skill/broken": expect.any(String),
    "claude/skill/taken": expect.stringMatching(/already has a Skill/),
    "claude/mcp/Bad.Name": expect.stringMatching(/can't be a BarnDog name/),
    "claude/mcp/DOCS": expect.stringMatching(
      /has docs, which differs only in case/,
    ),
    "claude/mcp/streaming": expect.stringMatching(/stdio and HTTP/),
    "opencode/mcp/twin": expect.stringMatching(/also configures twin/),
    "claude/hook/PostToolUse hook": expect.stringMatching(
      /same PostToolUse hook twice/,
    ),
    "claude/hook/Stop hook": expect.stringMatching(/prompt hook/),
    "claude/hook/Notification hook": expect.stringMatching(
      /two different scripts/,
    ),
    "claude/hook/SubagentStop hook": expect.stringMatching(/can't hold/),
  });

  // Both check.sh Hooks get their own names, clear of the local folder's.
  const hooks = scan.assets
    .filter((asset) => asset.kind === "hook")
    .map((asset) => asset.key)
    .sort();

  expect(hooks).toStrictEqual(["claude/hook/check-2", "cursor/hook/check-3"]);
  expect(scan.assets.map((asset) => asset.key)).toContain(
    "claude/mcp/My_Server",
  );

  expect(scan.assets.some((asset) => asset.key === "opencode/mcp/twin")).toBe(
    true,
  );

  // A renamed Hook still adopts and installs. The local folder's own taken
  // Skill would block that sync, since the tool has an unmanaged one too.
  await rm(join(folder, "org/skills/taken"), { recursive: true });
  await adoptNative(["cursor/hook/check-3"], [], runtime);
  expect(
    await readFile(join(folder, "org/hooks/check-3/hook.yaml"), "utf8"),
  ).toMatch(/name: check-3/);
});

/** Adds a hook that runs a command line with no script file of its own. */
async function inlineHook(home: string) {
  const file = join(home, ".claude/settings.json");
  const settings = JSON.parse(await readFile(file, "utf8")) as {
    hooks: Record<string, unknown[]>;
  };

  settings.hooks.Notification = [
    { hooks: [{ type: "command", command: "echo inline" }] },
  ];

  await writeFile(file, JSON.stringify(settings));
}

test("on Windows a hook command with no script file isn't adopted", async (t) => {
  const { home } = await machine(t, ["claude"]);
  await toolAssets(home);
  await inlineHook(home);
  const scan = await scanNative(testRuntime(home, { platform: "win32" }));

  expect(
    scan.skipped.find((s) => s.name === "Notification hook")?.reason,
  ).toMatch(/on Windows/);
});

// A wrapper script needs a POSIX shell, which is what the tools run hooks in there.
test.skipIf(process.platform === "win32")(
  "a hook command with no script file runs from a script BarnDog writes",
  async (t) => {
    const { home, folder, runtime } = await machine(t, ["claude"]);
    await toolAssets(home);
    await inlineHook(home);

    await adoptNative(["claude/hook/notification"], [], runtime);
    expect(
      await readFile(
        join(folder, "org/hooks/notification/notification-1.sh"),
        "utf8",
      ),
    ).toBe("#!/bin/sh\necho inline\n");

    const settings = await readFile(
      join(home, ".claude/settings.json"),
      "utf8",
    );

    expect(settings).not.toContain("echo inline");
    await undoAdoption({}, runtime);
    expect(
      await readFile(join(home, ".claude/settings.json"), "utf8"),
    ).toContain("echo inline");
  },
);

test("adopt list leaves out the settings an asset came from", async (t) => {
  const { home, runtime } = await machine(t, ["claude"]);
  await toolAssets(home);
  await write(
    home,
    ".claude.json",
    JSON.stringify({
      mcpServers: { keyed: { command: "k", env: { API_KEY: "sk-secret" } } },
    }),
  );

  const result = await adoptNative(["claude/mcp/keyed"], [], runtime);
  expect(result.values).toStrictEqual([
    { server: "keyed", variable: "API_KEY", kept: false },
  ]);

  const [listed] = await listAdoptions(home);
  expect(listed?.items[0]).toMatchObject({
    key: "claude/mcp/keyed",
    location: join(home, ".claude.json"),
  });

  expect(JSON.stringify(listed)).not.toContain("sk-secret");
  const undone = await undoAdoption({}, runtime);
  expect(JSON.stringify(undone)).not.toContain("sk-secret");
  expect(await json(join(home, ".claude.json"))).toMatchObject({
    mcpServers: { keyed: { env: { API_KEY: "sk-secret" } } },
  });
});

test("adopting stops before changing anything when it can't go ahead", async (t) => {
  const { home, folder, runtime } = await machine(t);
  await toolAssets(home);

  await expect(adoptNative([], [], runtime)).rejects.toThrow(/at least one/);

  // The copy's place filled up after the scan.
  const scan = await scanNative(runtime);
  expect(scan.assets.some((a) => a.key === "claude/mcp/lonely")).toBe(true);
  await write(folder, "org/mcp/lonely.yaml", "taken");
  await expect(adoptNative(["claude/mcp/lonely"], [], runtime)).rejects.toThrow(
    /isn't an asset BarnDog can adopt/,
  );

  expect(await readAdoptions(home)).toStrictEqual([]);
});

test("undo won't replace what took an adopted asset's place", async (t) => {
  const { home, runtime } = await machine(t, ["cursor"]);
  await toolAssets(home);
  const { id } = await adoptNative(["cursor/skill/linked"], [], runtime);

  // Something else now sits where the link was; BarnDog's link is gone after sync.
  const [record] = await readAdoptions(home);
  assert(record);
  await writeAdoption(
    {
      ...record,
      items: record.items.map((item) => ({
        ...item,
        original: {
          type: "link" as const,
          path: join(home, "occupied"),
          target: join(home, "elsewhere/linked"),
        },
      })),
    },
    home,
  );

  await write(home, "occupied", "mine");
  await expect(undoAdoption({ id }, runtime)).rejects.toThrow(/exists again/);
  await rm(join(home, "occupied"));
  await undoAdoption({ id }, runtime);
  expect(await realpath(join(home, "occupied"))).toBe(
    join(home, "elsewhere/linked"),
  );

  await expect(undoAdoption({ id }, runtime)).rejects.toThrow(/already undone/);
});

test("undo won't move a Skill folder over one that came back", async (t) => {
  const { home, runtime } = await machine(t, ["claude"]);
  await toolAssets(home);
  const { id } = await adoptNative(["claude/skill/notes"], [], runtime);
  const [record] = await readAdoptions(home);
  assert(record);
  await writeAdoption(
    {
      ...record,
      items: record.items.map((item) => ({
        ...item,
        original: { type: "folder" as const, path: join(home, "back") },
      })),
    },
    home,
  );

  await write(home, "back/SKILL.md", "new");
  await expect(undoAdoption({ id }, runtime)).rejects.toThrow(/exists again/);
});

test("a damaged adoption record stops adopt and undo", async (t) => {
  const { home, runtime } = await machine(t);
  await toolAssets(home);
  await adoptNative(["claude/mcp/lonely"], [], runtime);
  await adoptNative(["claude/skill/notes"], [], runtime);
  const records = await readAdoptions(home);
  expect(records.map((r) => r.items[0]?.key)).toStrictEqual([
    "claude/skill/notes",
    "claude/mcp/lonely",
  ]);

  const id = records[0]?.id ?? "";
  await writeFile(join(home, ".barndog/adoptions", id, "record.json"), "{");
  await expect(undoAdoption({ id }, runtime)).rejects.toThrow(/is damaged/);
});

test("an asset BarnDog doesn't install isn't adopted, and nothing changes", async (t) => {
  const { home, runtime } = await machine(t, ["claude"]);
  await toolAssets(home);

  // A copy's ID depends only on its place, so the second adoption reuses it.
  const first = await adoptNative(["claude/mcp/lonely"], [], runtime);
  const [record] = await readAdoptions(home);
  const assetId = record?.items[0]?.assetId;
  assert(assetId);
  await undoAdoption({ id: first.id }, runtime);

  const settings = await readSettings(home);
  assert(settings?.environment);
  await saveSettings(
    {
      ...settings,
      environment: {
        ...settings.environment,
        disabledAssetIds: [assetId],
      },
    },
    home,
  );

  await expect(adoptNative(["claude/mcp/lonely"], [], runtime)).rejects.toThrow(
    /couldn't install claude\/mcp\/lonely, so nothing was adopted/,
  );

  expect(await json(join(home, ".claude.json"))).toMatchObject({
    mcpServers: { lonely: { command: "lonely" } },
  });
});

test("adopting can keep an MCP server's values on this machine, and says where", async (t) => {
  const { home, runtime } = await machine(t, ["claude"]);
  await write(
    home,
    ".claude.json",
    JSON.stringify({
      mcpServers: {
        keyed: { command: "k", env: { API_KEY: "sk-secret", OTHER: "o" } },
      },
    }),
  );

  const scan = await scanNative(runtime);
  expect(
    scan.assets.find((asset) => asset.key === "claude/mcp/keyed")?.values,
  ).toStrictEqual([
    { key: "API_KEY", variable: "API_KEY" },
    { key: "OTHER", variable: "OTHER" },
  ]);

  expect(JSON.stringify(scan)).not.toContain("sk-secret");
  const result = await adoptNative(
    ["claude/mcp/keyed"],
    [{ server: "keyed", variable: "API_KEY" }],
    runtime,
  );

  const { native } = await readState(home);
  const id = native.find((entry) => entry.key === "keyed")?.id;
  expect(await readStoredSecrets(runtime)).toStrictEqual({
    version: 2,
    servers: { [id!]: { API_KEY: { value: "sk-secret" } } },
    unassigned: {},
  });

  expect(result.notes).toStrictEqual([]);
  expect(result.values).toStrictEqual([
    { server: "keyed", variable: "API_KEY", kept: true },
    { server: "keyed", variable: "OTHER", kept: false },
  ]);

  const claude = await json(join(home, ".claude.json"));
  expect(claude).toMatchObject({
    mcpServers: { keyed: { env: { API_KEY: "sk-secret", OTHER: "${OTHER}" } } },
  });
});
