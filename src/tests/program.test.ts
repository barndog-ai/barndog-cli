import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { CommanderError } from "commander";
import { createProgram } from "../program.js";
import { SetupRequiredError } from "../config/settings.js";
import { renderError } from "../ui/output.js";
import { CliError } from "../errors.js";

function setup() {
  const output: string[] = [];
  const errors: string[] = [];
  const setups: boolean[] = [];
  const syncs: (string | undefined)[] = [];
  const program = createProgram({
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

test("bare command prints grouped help without running setup; init requests confirmed re-entry", async () => {
  const bare = setup();
  await assert.rejects(
    bare.program.parseAsync([], { from: "user" }),
    (error) => error instanceof CommanderError && error.exitCode === 0,
  );
  assert.deepEqual(bare.setups, []);
  const help = bare.output.join("\n");
  for (const heading of [
    "Get started:",
    "Assets:",
    "Working copy & review",
    "Workspace:",
  ])
    assert.ok(help.includes(heading), heading);
  assert.ok(help.indexOf("Assets:") < help.indexOf("Working copy & review"));
  const init = setup();
  await init.program.parseAsync(["init"], { from: "user" });
  assert.deepEqual(init.setups, [true]);
  assert.deepEqual(init.syncs, []);
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
    await assert.rejects(
      f.program.parseAsync(args, { from: "user" }),
      (error) => error instanceof CommanderError && error.exitCode === 0,
    );
    assert.match(f.output.join("\n"), /Usage: barndog/);
    if (args.includes("sync")) assert.match(f.output.join("\n"), /--config/);
    assert.deepEqual(f.setups, []);
    assert.deepEqual(f.syncs, []);
    assert.deepEqual(f.errors, []);
  });
}

test("sync without flags leaves default home-config resolution to the feature", async () => {
  const f = setup();
  await f.program.parseAsync(["sync"], { from: "user" });
  assert.deepEqual(f.syncs, [undefined]);
  assert.deepEqual(f.setups, []);
  assert.match(f.output.join("\n"), /Sync complete/);
});

for (const args of [
  ["sync", "--config", "example.yaml"],
  ["sync", "--config=example.yaml"],
]) {
  test(`configuration flag parses correctly: ${args.join(" ")}`, async () => {
    const f = setup();
    await f.program.parseAsync(args, { from: "user" });
    assert.deepEqual(f.syncs, [resolve("example.yaml")]);
  });
}

for (const args of [
  ["unknown"],
  ["--unknown"],
  ["sync", "--unknown"],
  ["sync", "--config"],
  ["init", "extra"],
  ["sync", "extra"],
]) {
  test(`invalid arguments are rejected before any action: ${args.join(" ")}`, async () => {
    const f = setup();
    await assert.rejects(
      f.program.parseAsync(args, { from: "user" }),
      (error) => error instanceof CommanderError && error.exitCode !== 0,
    );
    assert.ok(f.errors.length > 0);
    assert.deepEqual(f.setups, []);
    assert.deepEqual(f.syncs, []);
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
  await assert.rejects(
    program.parseAsync(["sync"], { from: "user" }),
    (error) => error === failure,
  );
  assert.deepEqual(output, []);
  assert.match(renderError(failure), /barndog init/);
});

test("CLI returns correct exit codes for help and parsing errors", () => {
  const executable = new URL("../cli.js", import.meta.url).pathname;
  const help = spawnSync(process.execPath, [executable, "sync", "--help"], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--config/);
  assert.equal(help.stderr, "");
  const invalid = spawnSync(
    process.execPath,
    [executable, "sync", "--config"],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /argument missing/);
  assert.doesNotMatch(invalid.stdout, /Sync complete/);
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
  assert.deepEqual(calls, [
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
      items: [],
    }),
    environment: async (...args) => {
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
  assert.equal(searched, true);
  assert.deepEqual(calls, []);
  await program.parseAsync(
    ["skills", "install", "example", "--origin", "team:engineering"],
    { from: "user" },
  );
  assert.deepEqual(calls, [
    ["install", { origin: "team:engineering", name: "example", kind: "skill" }],
  ]);
});

test("missing asset names fail with a usage hint instead of prompting off a terminal", async () => {
  const program = createProgram({
    write: () => {},
    interactive: false,
    environment: async () => {
      throw new Error("Unexpected operation");
    },
  });
  for (const args of [
    ["skills", "install"],
    ["mcp", "disable"],
    ["hooks", "remove"],
    ["sets", "install"],
  ])
    await assert.rejects(
      program.parseAsync(args, { from: "user" }),
      (error) => error instanceof CliError && /barndog/.test(error.hint ?? ""),
    );
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
  ])
    await program.parseAsync(args, { from: "user" });
  assert.deepEqual(calls, [
    ["login", { browser: true, force: true }],
    ["logout"],
    ["status"],
    ["status"],
    ["status"],
  ]);
});

test("errors render a message and a fix command", () => {
  const text = renderError(new CliError("Something broke.", "barndog doctor"));
  assert.match(text, /Something broke\./);
  assert.match(text, /Fix:.*barndog doctor/);
});

test("collaboration commands pass parsed arguments without performing workflow IO", async () => {
  const calls: unknown[] = [];
  const program = createProgram({
    write: () => {},
    collaborate: async (...args) => {
      calls.push(args);
      return { unchanged: true };
    },
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
  assert.deepEqual(calls.pop(), [
    "pull-skill",
    { name: "review", origin: "team/frontend", directory: "editable" },
  ]);
  await program.parseAsync(
    ["push", "--publish", "--new", "--title", "Improve instructions"],
    { from: "user" },
  );
  assert.deepEqual(calls.pop(), [
    "push",
    { publish: true, new: true, title: "Improve instructions" },
  ]);
  await program.parseAsync(["changes", "approve", "id", "--revision", "3"], {
    from: "user",
  });
  assert.deepEqual(calls.pop(), ["approve", { id: "id", revision: 3 }]);
  await program.parseAsync(
    ["skills", "changes", "approve", "id", "--revision", "4"],
    { from: "user" },
  );
  assert.deepEqual(calls.pop(), ["approve", { id: "id", revision: 4 }]);
});

test("review commands require an explicit positive revision before workflow IO", async () => {
  let calls = 0;
  for (const args of [
    ["changes", "approve", "id"],
    ["changes", "merge", "id", "--revision", "0"],
    ["changes", "reject", "id", "--revision", "1.2"],
  ]) {
    const program = createProgram({
      write: () => {},
      writeError: () => {},
      collaborate: async () => {
        calls++;
      },
    });
    await assert.rejects(
      program.parseAsync(args, { from: "user" }),
      CommanderError,
    );
  }
  assert.equal(calls, 0);
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
  assert.deepEqual(calls, [[true, undefined, { local: true, browser: false }]]);
  await assert.rejects(
    program.parseAsync(["init", "--local", "--server", "https://example.com"], {
      from: "user",
    }),
    CommanderError,
  );
  assert.equal(calls.length, 1);
});

test("a failed Hook test sets the exit code with or without --json", async (t) => {
  const previous = process.exitCode;
  t.after(() => {
    process.exitCode = previous;
  });
  const run = async (...extra: string[]) => {
    process.exitCode = undefined;
    const lines: string[] = [];
    await createProgram({
      write: (line) => lines.push(line),
      writeError: () => {},
      interactive: false,
      capability: async () => ({
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
  assert.equal(plain.code, 7);
  assert.match(plain.text, /exited 7/);
  const asJson = await run("--json");
  assert.equal(asJson.code, 7);
  assert.equal(JSON.parse(asJson.text).exitCode, 7);
});

test("offline status reports what is installed without claiming it is current", async () => {
  const lines: string[] = [];
  await createProgram({
    write: (line) => lines.push(line),
    writeError: () => {},
    interactive: false,
    collaborate: async () => ({ mode: "environment" }),
    inventory: async () => ({
      harnesses: ["claude"],
      server: "https://barndog.example.com",
      knowledge: false,
      offline: "fetch failed",
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
  assert.match(text, /Showing local state only: fetch failed/);
  assert.match(text, /1 asset installed\. Couldn't check for updates/);
  assert.doesNotMatch(text, /up to date/);
});

test("--version prints the package version and build details", async () => {
  const lines: string[] = [];
  const program = createProgram({
    write: (line) => lines.push(line),
    writeError: () => {},
  });
  await assert.rejects(
    program.parseAsync(["--version"], { from: "user" }),
    (error: { code?: string; exitCode?: number }) =>
      error.code === "commander.version" && error.exitCode === 0,
  );
  const { version } = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  assert.match(lines.join("\n"), new RegExp(`^barndog ${version}\\n`));
  assert.match(lines.join("\n"), /Node\.js v\d+.* on \w+ \w+/);
  assert.match(lines.join("\n"), /Default server https?:\/\//);
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
    capability: async (...args) => {
      calls.push(args);
      return { version: 1, compatibility: [] };
    },
  });
  await program.parseAsync(["hooks", "compatibility", "guard"], {
    from: "user",
  });
  assert.deepEqual(calls.pop(), [
    "hooks-compatibility",
    { name: "guard", origin: "local" },
  ]);
  await program.parseAsync(
    ["hooks", "compatibility", "lint", "--origin", "team/web"],
    { from: "user" },
  );
  assert.deepEqual(calls.pop(), [
    "hooks-compatibility",
    { origin: "team/web", name: "lint" },
  ]);
  await assert.rejects(
    program.parseAsync(["hooks", "compatibility", "lint"], { from: "user" }),
    (error) =>
      error instanceof CliError &&
      /several scopes: org, team\/web/.test(error.message) &&
      error.hint === "barndog hooks compatibility lint --origin org",
  );
  await assert.rejects(
    program.parseAsync(["hooks", "compatibility", "missing"], {
      from: "user",
    }),
    (error) =>
      error instanceof CliError &&
      error.hint === "barndog hooks search missing",
  );
  for (const command of ["compatibility", "adapt"])
    await assert.rejects(
      program.parseAsync(["hooks", command], { from: "user" }),
      (error) =>
        error instanceof CliError &&
        error.hint === `barndog hooks ${command} <name>`,
    );
  assert.equal(calls.length, 0);
});

test("Hook compatibility shows support and readiness with a short version", async () => {
  const run = async (version: number | string) => {
    const lines: string[] = [];
    await createProgram({
      write: (line) => lines.push(line),
      interactive: false,
      capability: async () => ({
        version,
        compatibility: [
          {
            harness: "claude",
            status: "supported",
            declared: true,
            runtimeIssue: null,
          },
          {
            harness: "codex",
            status: "partial",
            declared: true,
            runtimeIssue: "Missing runtime: jq",
          },
          {
            harness: "cursor",
            status: "unsupported",
            declared: true,
            runtimeIssue: "No implementation for this harness",
          },
        ],
      }),
    }).parseAsync(["hooks", "compatibility", "guard", "--origin", "org"], {
      from: "user",
    });
    return stripVTControlCharacters(lines.join("\n"));
  };
  const text = await run(3);
  assert.match(text, /Version\s+3/);
  assert.match(text, /Tool\s+Support\s+Ready on this machine/);
  assert.match(text, /claude\s+supported\s+✔/);
  assert.match(text, /codex\s+partial\s+✖ Missing runtime: jq/);
  assert.match(text, /barndog hooks adapt guard --for cursor/);
  assert.doesNotMatch(text, /Declared|Tested|No implementation/);
  const local = await run("ac93c0ce639c89b0f4871900b90039c17fd7ffe3");
  assert.match(local, /Version\s+ac93c0c\n/);
  assert.doesNotMatch(local, /ac93c0ce/);
});
