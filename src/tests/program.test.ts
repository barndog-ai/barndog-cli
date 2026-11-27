import { expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { built } from "./built.js";
import { stripVTControlCharacters } from "node:util";
import { CommanderError } from "commander";
import { createProgram } from "../program.js";
import { saveSettings, SetupRequiredError } from "../config/settings.js";
import { renderError } from "../ui/output.js";
import { CliError } from "../errors.js";

function setup(machine: { interactive?: boolean; isSetUp?: boolean } = {}) {
  const output: string[] = [];
  const errors: string[] = [];
  const setups: boolean[] = [];
  const syncs: (string | undefined)[] = [];
  const program = createProgram({
    interactive: machine.interactive ?? false,
    isSetUp: async () => machine.isSetUp ?? true,
    write: (text) => output.push(text),
    writeError: (text) => errors.push(text),
    setup: async (restart) => {
      setups.push(restart);
    },
    synchronize: async (path) => {
      syncs.push(path);

      return [];
    },
  });

  return { program, output, errors, setups, syncs };
}

test("bare command on a machine that isn't set up runs setup in a terminal", async () => {
  const fresh = setup({ interactive: true, isSetUp: false });
  await fresh.program.parseAsync([], { from: "user" });
  expect(fresh.setups).toStrictEqual([true]);
  expect(fresh.output).toStrictEqual([]);

  for (const machine of [
    { interactive: false, isSetUp: false },
    { interactive: true, isSetUp: true },
  ]) {
    const f = setup(machine);
    await expect(f.program.parseAsync([], { from: "user" })).rejects.toSatisfy(
      (error) => error instanceof CommanderError && error.exitCode === 0,
    );

    expect(f.setups, JSON.stringify(machine)).toStrictEqual([]);
    expect(f.output.join("\n")).toContain("Get started:");
  }
});

test("bare command prints grouped help without running setup; init requests confirmed re-entry", async () => {
  const bare = setup({ interactive: true });
  await expect(bare.program.parseAsync([], { from: "user" })).rejects.toSatisfy(
    (error) => error instanceof CommanderError && error.exitCode === 0,
  );

  expect(bare.setups).toStrictEqual([]);
  const help = bare.output.join("\n");
  for (const heading of [
    "Get started:",
    "Assets:",
    "Working copy & review",
    "Workspace:",
  ]) {
    expect(help, heading).toContain(heading);
  }

  expect(
    help.indexOf("Assets:") < help.indexOf("Working copy & review"),
  ).toBeTruthy();

  const init = setup();
  await init.program.parseAsync(["init"], { from: "user" });
  expect(init.setups).toStrictEqual([true]);
  expect(init.syncs).toStrictEqual([]);
});

for (const args of [
  ["--help"],
  ["-h"],
  ["init", "--help"],
  ["sync", "--help"],
  ["help", "sync"],
]) {
  test(`generated help for ${args.join(" ")} exits successfully without executing commands`, async () => {
    const f = setup();
    await expect(
      f.program.parseAsync(args, { from: "user" }),
    ).rejects.toSatisfy(
      (error) => error instanceof CommanderError && error.exitCode === 0,
    );

    expect(f.output.join("\n")).toMatch(/Usage: barndog/);
    if (args.includes("sync")) {
      expect(f.output.join("\n")).toMatch(/--config/);
    }

    expect(f.setups).toStrictEqual([]);
    expect(f.syncs).toStrictEqual([]);
    expect(f.errors).toStrictEqual([]);
  });
}

test("sync without flags leaves default home-config resolution to the feature", async () => {
  const f = setup();
  await f.program.parseAsync(["sync"], { from: "user" });
  expect(f.syncs).toStrictEqual([undefined]);
  expect(f.setups).toStrictEqual([]);
  expect(f.output.join("\n")).toMatch(/Sync complete/);
});

for (const args of [
  ["sync", "--config", "example.yaml"],
  ["sync", "--config=example.yaml"],
]) {
  test(`configuration flag parses correctly: ${args.join(" ")}`, async () => {
    const f = setup();
    await f.program.parseAsync(args, { from: "user" });
    expect(f.syncs).toStrictEqual([resolve("example.yaml")]);
  });
}

for (const args of [
  ["unknown"],
  ["--unknown"],
  ["sync", "--unknown"],
  ["sync", "--config"],
  ["init", "extra"],
  ["sync", "extra"],
  // --auto is the quiet background sync; it would ignore these.
  ["sync", "--auto", "--dry-run"],
  ["sync", "--auto", "--verbose"],
  ["sync", "--auto", "--config", "example.yaml"],
]) {
  test(`invalid arguments are rejected before any action: ${args.join(" ")}`, async () => {
    const f = setup();
    await expect(
      f.program.parseAsync(args, { from: "user" }),
    ).rejects.toSatisfy(
      (error) => error instanceof CommanderError && error.exitCode !== 0,
    );

    expect(f.errors).not.toHaveLength(0);
    expect(f.setups).toStrictEqual([]);
    expect(f.syncs).toStrictEqual([]);
  });
}

test("async feature failures propagate without a success message; UI supplies formatted recovery advice", async () => {
  const output: string[] = [];
  const failure = new SetupRequiredError();
  const program = createProgram({
    write: (text) => output.push(text),
    synchronize: async () => {
      throw failure;
    },
  });

  await expect(
    program.parseAsync(["sync"], { from: "user" }),
  ).rejects.toSatisfy((error) => error === failure);

  expect(output).toStrictEqual([]);
  expect(renderError(failure)).toMatch(/barndog init/);
});

test("CLI returns correct exit codes for help and parsing errors", () => {
  const executable = built("cli.js");
  const help = spawnSync(process.execPath, [executable, "sync", "--help"], {
    encoding: "utf8",
    timeout: 5000,
  });

  expect(help.status).toBe(0);
  expect(help.stdout).toMatch(/--config/);
  expect(help.stderr).toBe("");
  const invalid = spawnSync(
    process.execPath,
    [executable, "sync", "--config"],
    { encoding: "utf8", timeout: 5000 },
  );

  expect(invalid.status).toBe(1);
  expect(invalid.stderr).toMatch(/argument missing/);
  expect(invalid.stdout).not.toMatch(/Sync complete/);
});

test("init forwards an explicit server through the confirmed setup workflow", async () => {
  const calls: unknown[] = [];
  const program = createProgram({
    setup: async (...args) => {
      calls.push(args);
    },
    write: () => {},
  });

  await program.parseAsync(["init", "--server", "http://127.0.0.1:3000"], {
    from: "user",
  });

  expect(calls).toStrictEqual([
    [true, "http://127.0.0.1:3000", { local: undefined, browser: true }],
  ]);
});

test("asset search never synchronizes and install forwards name and origin", async () => {
  const calls: unknown[] = [];
  let searched = false;
  const program = createProgram({
    searchCatalog: async () => {
      searched = true;

      return [];
    },
    inventory: async () => ({
      harnesses: [],
      server: null,
      knowledge: false,
      offline: null,
      moving: [],
      items: [],
    }),
    changeAsset: async (...args) => {
      calls.push(args);

      return { status: "applied", events: [] };
    },
    synchronize: async () => {
      throw new Error("Unexpected sync");
    },
    write: () => {},
    interactive: false,
  });

  await program.parseAsync(["skills", "search"], { from: "user" });
  expect(searched).toBe(true);
  expect(calls).toStrictEqual([]);
  await program.parseAsync(
    ["skills", "install", "example", "--origin", "team:engineering"],
    { from: "user" },
  );

  expect(calls).toStrictEqual([
    [
      "install",
      {
        origin: "team:engineering",
        name: "example",
        kind: "skill",
        resolution: undefined,
      },
    ],
  ]);
});

test("missing asset names fail with a usage hint instead of prompting off a terminal", async () => {
  const unexpected = async () => {
    throw new Error("Unexpected operation");
  };

  const program = createProgram({
    write: () => {},
    interactive: false,
    changeAsset: unexpected,
    changeAssets: unexpected,
    installSet: unexpected,
    changeSet: unexpected,
  });

  for (const args of [
    ["skills", "install"],
    ["mcp", "disable"],
    ["hooks", "remove"],
    ["sets", "install"],
  ]) {
    await expect(program.parseAsync(args, { from: "user" })).rejects.toSatisfy(
      (error) => error instanceof CliError && /barndog/.test(error.hint ?? ""),
    );
  }
});

test("login, logout and auth status route to their handlers; whoami matches auth status", async () => {
  const calls: unknown[] = [];
  const program = createProgram({
    write: () => {},
    login: async (options) => {
      calls.push(["login", options]);
    },
    logout: async () => {
      calls.push(["logout"]);
    },
    authStatus: async () => {
      calls.push(["status"]);
    },
  });

  for (const args of [
    ["login", "--force"],
    ["logout"],
    ["auth", "status"],
    ["auth"],
    ["whoami"],
  ]) {
    await program.parseAsync(args, { from: "user" });
  }

  expect(calls).toStrictEqual([
    ["login", { browser: true, force: true }],
    ["logout"],
    ["status"],
    ["status"],
    ["status"],
  ]);
});

test("errors render a message and a fix command", () => {
  const text = renderError(new CliError("Something broke.", "barndog doctor"));
  expect(text).toMatch(/Something broke\./);
  expect(text).toMatch(/Fix:.*barndog doctor/);
});

test("collaboration commands pass parsed arguments without performing workflow IO", async () => {
  const calls: unknown[] = [];
  // The command only prints what comes back, so the result's shape isn't under test.
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);

      return { unchanged: true } as never;
    };

  const program = createProgram({
    write: () => {},
    pullPackage: record("pullPackage"),
    pushWorkingCopy: record("pushWorkingCopy"),
    reviewChange: record("reviewChange"),
  });

  await program.parseAsync(
    [
      "skills",
      "pull",
      "review",
      "--origin",
      "team/frontend",
      "--directory",
      "editable",
    ],
    { from: "user" },
  );

  expect(calls.pop()).toStrictEqual([
    "pullPackage",
    {
      kind: "skill",
      name: "review",
      origin: "team/frontend",
      directory: "editable",
    },
  ]);

  await program.parseAsync(
    ["push", "--publish", "--new", "--title", "Improve instructions"],
    { from: "user" },
  );

  expect(calls.pop()).toStrictEqual([
    "pushWorkingCopy",
    { publish: true, new: true, title: "Improve instructions" },
  ]);

  await program.parseAsync(
    ["hooks", "changes", "approve", "id", "--revision", "3"],
    { from: "user" },
  );

  expect(calls.pop()).toStrictEqual([
    "reviewChange",
    "approve",
    { kind: "hook", id: "id", revision: 3 },
  ]);

  await expect(
    program.parseAsync(["changes", "list"], { from: "user" }),
  ).rejects.toThrow(/unknown command/);

  await program.parseAsync(
    ["skills", "changes", "approve", "id", "--revision", "4"],
    { from: "user" },
  );

  expect(calls.pop()).toStrictEqual([
    "reviewChange",
    "approve",
    { kind: "skill", id: "id", revision: 4 },
  ]);
});

test("review commands require an explicit positive revision before workflow IO", async () => {
  let calls = 0;
  const count = async () => {
    calls++;

    return {} as never;
  };

  for (const args of [
    ["skills", "changes", "approve", "id"],
    ["hooks", "changes", "merge", "id", "--revision", "0"],
    ["skills", "changes", "reject", "id", "--revision", "1.2"],
  ]) {
    const program = createProgram({
      write: () => {},
      writeError: () => {},
      reviewChange: count,
      rejectChange: count,
      mergeChange: count,
    });

    await expect(program.parseAsync(args, { from: "user" })).rejects.toThrow(
      CommanderError,
    );
  }

  expect(calls).toBe(0);
});

test("init forwards local and browser-free setup options and rejects conflicting modes", async () => {
  const calls: unknown[] = [];
  const program = createProgram({
    write: () => {},
    writeError: () => {},
    setup: async (...args) => {
      calls.push(args);
    },
  });

  await program.parseAsync(["init", "--local", "--no-browser"], {
    from: "user",
  });

  expect(calls).toStrictEqual([
    [true, undefined, { local: true, browser: false }],
  ]);

  await expect(
    program.parseAsync(["init", "--local", "--server", "https://example.com"], {
      from: "user",
    }),
  ).rejects.toThrow(CommanderError);

  expect(calls.length).toBe(1);
});

test("a failed Hook test sets the exit code with or without --json", async (t) => {
  const previous = process.exitCode;
  t.onTestFinished(() => {
    process.exitCode = previous;
  });

  const run = async (...extra: string[]) => {
    process.exitCode = undefined;
    const lines: string[] = [];
    await createProgram({
      write: (line) => lines.push(line),
      writeError: () => {},
      interactive: false,
      testHook: async () => ({
        harness: "claude",
        event: "PreToolUse",
        stdout: "",
        stderr: "boom",
        exitCode: 7,
        timedOut: false,
      }),
    }).parseAsync(
      [
        ...extra,
        "hooks",
        "test",
        "guard",
        "--origin",
        "local",
        "--harness",
        "claude",
        "--input",
        "input.json",
      ],
      { from: "user" },
    );

    return { code: process.exitCode, text: lines.join("\n") };
  };

  const plain = await run();
  expect(plain.code).toBe(7);
  expect(plain.text).toMatch(/exited 7/);
  const asJson = await run("--json");
  expect(asJson.code).toBe(7);
  expect(JSON.parse(asJson.text).exitCode).toBe(7);
});

test("offline status reports what is installed without claiming it is current", async () => {
  const lines: string[] = [];
  await createProgram({
    write: (line) => lines.push(line),
    writeError: () => {},
    interactive: false,
    workingStatus: async () => ({ mode: "environment" }),
    inventory: async () => ({
      harnesses: ["claude"],
      server: "https://barndog.example.com",
      knowledge: false,
      offline: "fetch failed",
      moving: [{ kind: "skill", name: "mine", to: "https://example.test/1" }],
      items: [
        {
          id: "1",
          kind: "skill",
          name: "review",
          installedName: "review",
          origin: "org",
          via: [],
          state: "installed",
          harnesses: ["claude"],
          paths: [],
        },
      ],
    }),
  }).parseAsync(["status"], { from: "user" });

  const text = lines.join("\n");
  expect(text).toMatch(/Showing local state only: fetch failed/);
  expect(text).toMatch(
    /mine is moving to https:\/\/example\.test\/1\. Your local copy stays in use until that merges\./,
  );

  expect(text).toMatch(/1 asset installed\. Couldn't check for updates/);
  expect(text).not.toMatch(/up to date/);
});

test("--version prints the package version and build details", async () => {
  const lines: string[] = [];
  const program = createProgram({
    write: (line) => lines.push(line),
    writeError: () => {},
  });

  await expect(
    program.parseAsync(["--version"], { from: "user" }),
  ).rejects.toSatisfy(
    (error: { code?: string; exitCode?: number }) =>
      error.code === "commander.version" && error.exitCode === 0,
  );

  const { version } = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };

  expect(lines.join("\n")).toMatch(new RegExp(`^barndog ${version}\\n`));
  expect(lines.join("\n")).toMatch(/Node\.js v\d.* on \w+ \w+/);
  expect(lines.join("\n")).toMatch(/Default server https?:\/\//);
});

test("lookup commands infer --origin when one scope has the name", async () => {
  const calls: unknown[] = [];
  const row = (name: string, type: string, slug: string) => ({
    id: `${type}-${slug}-${name}`,
    kind: "hook" as const,
    name,
    origin: { type, id: `${type}-${slug}`, slug },
    version: { number: 1, description: name },
  });

  const program = createProgram({
    write: () => {},
    interactive: false,
    searchCatalog: async () => [
      {
        ...row("guard", "dev", "local"),
        origin: { ...row("guard", "dev", "local").origin, localOnly: true },
      },
      row("lint", "org", "acme"),
      row("lint", "team", "web"),
    ],
    hookCompatibility: async (...args) => {
      calls.push(args);

      return { version: 1, compatibility: [] };
    },
  });

  await program.parseAsync(["hooks", "compatibility", "guard"], {
    from: "user",
  });

  expect(calls.pop()).toStrictEqual(["guard", "local"]);
  await program.parseAsync(
    ["hooks", "compatibility", "lint", "--origin", "team/web"],
    { from: "user" },
  );

  expect(calls.pop()).toStrictEqual(["lint", "team/web"]);
  await expect(
    program.parseAsync(["hooks", "compatibility", "lint"], { from: "user" }),
  ).rejects.toSatisfy(
    (error) =>
      error instanceof CliError &&
      /several scopes: org, team\/web/.test(error.message) &&
      error.hint === "barndog hooks compatibility lint --origin org",
  );

  await expect(
    program.parseAsync(["hooks", "compatibility", "missing"], {
      from: "user",
    }),
  ).rejects.toSatisfy(
    (error) =>
      error instanceof CliError &&
      error.hint === "barndog hooks search missing",
  );

  for (const command of ["compatibility", "adapt"]) {
    await expect(
      program.parseAsync(["hooks", command], { from: "user" }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof CliError &&
        error.hint === `barndog hooks ${command} <name>`,
    );
  }

  expect(calls.length).toBe(0);
});

test("Hook compatibility shows support, readiness, requirements and the author's notes", async () => {
  const implementation = (
    requirements: { commands: string[]; harnessVersion?: string },
    notes?: string,
  ) => ({
    compatibility: "supported",
    scripts: [],
    requirements,
    events: { Stop: [] },
    ...(notes ? { notes } : {}),
  });

  const run = async (version: number | string) => {
    const lines: string[] = [];
    await createProgram({
      write: (line) => lines.push(line),
      interactive: false,
      hookCompatibility: async () =>
        ({
          version,
          compatibility: [
            {
              harness: "claude",
              status: "supported",
              declared: true,
              implementation: implementation({
                commands: ["node"],
                harnessVersion: ">=2",
              }),
              missingRequirements: [],
              runtimeIssue: null,
            },
            {
              harness: "codex",
              status: "partial",
              declared: true,
              implementation: implementation(
                { commands: ["jq"] },
                "No SubagentStop event in Codex.",
              ),
              missingRequirements: [{ type: "command", command: "jq" }],
              runtimeIssue: "needs the jq command",
            },
            {
              harness: "cursor",
              status: "unsupported",
              declared: true,
              implementation: null,
              missingRequirements: [],
              runtimeIssue: "No implementation for this harness",
            },
          ],
        }) as never,
    }).parseAsync(["hooks", "compatibility", "guard", "--origin", "org"], {
      from: "user",
    });

    return stripVTControlCharacters(lines.join("\n"));
  };

  const text = await run(3);
  expect(text).toMatch(/Version\s+3/);
  expect(text).toMatch(/Tool\s+Author says\s+On this machine\s+Events/);
  expect(text).toMatch(/Claude Code\s+supported\s+✔ ready\s+Stop/);
  expect(text).toMatch(/Codex\s+partial\s+! missing requirement\s+Stop/);
  expect(text).toMatch(/Cursor\s+—\s+—\s+—/);
  expect(text).toMatch(/Claude Code\s+node command\s+✔/);
  expect(text).toMatch(/Claude Code\s+Claude Code >=2\s+✔/);
  expect(text).toMatch(
    /Codex\s+jq command\s+! not installed or not on your PATH/,
  );

  expect(text).toMatch(/Fix: Install jq, then run barndog sync/);
  expect(text).toMatch(
    /Author's notes\n\s+Codex\s+No SubagentStop event in Codex\./,
  );

  expect(text).toMatch(/partial: the author says only part of this Hook works/);
  expect(text).toMatch(/barndog hooks adapt guard --for cursor/);
  const local = await run("ac93c0ce639c89b0f4871900b90039c17fd7ffe3");
  expect(local).toMatch(/Version\s+ac93c0c\n/);
  expect(local).not.toMatch(/ac93c0ce/);
});

test("a partial Hook without notes says the author left none", async () => {
  const lines: string[] = [];
  await createProgram({
    write: (line) => lines.push(line),
    interactive: false,
    hookCompatibility: async () =>
      ({
        version: 1,
        compatibility: [
          {
            harness: "codex",
            status: "partial",
            declared: true,
            implementation: {
              compatibility: "partial",
              scripts: [],
              requirements: { commands: [] },
              events: { Stop: [] },
            },
            missingRequirements: [],
            runtimeIssue: null,
          },
        ],
      }) as never,
  }).parseAsync(["hooks", "compatibility", "guard", "--origin", "org"], {
    from: "user",
  });

  const text = stripVTControlCharacters(lines.join("\n"));
  expect(text).toMatch(
    /Codex\s+The author marked this partial but didn't say what's missing\./,
  );

  expect(text).not.toMatch(/Requirements/);
});

test("hooks compatibility --all shows every selected Hook against each tool", async () => {
  const lines: string[] = [];
  const row = (
    harness: "claude" | "codex",
    status: "supported" | "partial" | "unsupported",
    missing = false,
  ) => ({
    harness,
    status,
    declared: true,
    implementation: null,
    missingRequirements: missing ? [{ type: "command", command: "deno" }] : [],
    runtimeIssue: null,
  });

  await createProgram({
    write: (line) => lines.push(line),
    interactive: false,
    allHookCompatibility: async () =>
      [
        {
          name: "guard",
          origin: "org",
          compatibility: [row("claude", "supported"), row("codex", "partial")],
        },
        {
          name: "lint",
          origin: "local",
          compatibility: [
            row("claude", "supported", true),
            row("codex", "unsupported"),
          ],
        },
      ] as never,
  }).parseAsync(["hooks", "compatibility", "--all"], { from: "user" });

  const text = stripVTControlCharacters(lines.join("\n"));
  expect(text).toMatch(/Hook\s+Claude Code\s+Codex/);
  expect(text).toMatch(/guard\s+✔ supported\s+◐ partial/);
  expect(text).toMatch(/lint\s+! can't run\s+—/);
  expect(text).toMatch(/—\s+not written for that tool/);
  expect(text).toMatch(/Tip: barndog hooks show <name>/);
});

test("hooks compatibility --all takes no name, and says so when there are no Hooks", async () => {
  const lines: string[] = [];
  const program = () =>
    createProgram({
      write: (line) => lines.push(line),
      interactive: false,
      allHookCompatibility: async () => [],
    });

  await expect(
    program().parseAsync(["hooks", "compatibility", "guard", "--all"], {
      from: "user",
    }),
  ).rejects.toThrow("--all shows every selected Hook");

  await program().parseAsync(["hooks", "compatibility", "--all"], {
    from: "user",
  });

  expect(lines).toEqual(["No Hooks are selected on this machine."]);
});

test("a machine counts as set up once config.yaml exists", async () => {
  const home = await mkdtemp(join(tmpdir(), "barndog-bare-"));
  const setups: boolean[] = [];
  const bare = () =>
    createProgram({
      home,
      interactive: true,
      write: () => {},
      setup: async (restart) => {
        setups.push(restart);
      },
    }).parseAsync([], { from: "user" });

  try {
    await bare();
    expect(setups).toStrictEqual([true]);

    await saveSettings({ harnesses: ["claude"] }, home);
    await expect(bare()).rejects.toBeInstanceOf(CommanderError);
    expect(setups).toStrictEqual([true]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
