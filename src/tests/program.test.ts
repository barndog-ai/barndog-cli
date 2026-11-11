import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { built } from "./built.js";
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
  ])
    expect(help, heading).toContain(heading);
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
    if (args.includes("sync")) expect(f.output.join("\n")).toMatch(/--config/);
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
  expect(searched).toBe(true);
  expect(calls).toStrictEqual([]);
  await program.parseAsync(
    ["skills", "install", "example", "--origin", "team:engineering"],
    { from: "user" },
  );
  expect(calls).toStrictEqual([
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
    await expect(program.parseAsync(args, { from: "user" })).rejects.toSatisfy(
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
  expect(calls.pop()).toStrictEqual([
    "pull-skill",
    { name: "review", origin: "team/frontend", directory: "editable" },
  ]);
  await program.parseAsync(
    ["push", "--publish", "--new", "--title", "Improve instructions"],
    { from: "user" },
  );
  expect(calls.pop()).toStrictEqual([
    "push",
    { publish: true, new: true, title: "Improve instructions" },
  ]);
  await program.parseAsync(["changes", "approve", "id", "--revision", "3"], {
    from: "user",
  });
  expect(calls.pop()).toStrictEqual(["approve", { id: "id", revision: 3 }]);
  await program.parseAsync(
    ["skills", "changes", "approve", "id", "--revision", "4"],
    { from: "user" },
  );
  expect(calls.pop()).toStrictEqual(["approve", { id: "id", revision: 4 }]);
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
  expect(text).toMatch(/Showing local state only: fetch failed/);
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
  expect(lines.join("\n")).toMatch(/Node\.js v\d+.* on \w+ \w+/);
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
    capability: async (...args) => {
      calls.push(args);
      return { version: 1, compatibility: [] };
    },
  });
  await program.parseAsync(["hooks", "compatibility", "guard"], {
    from: "user",
  });
  expect(calls.pop()).toStrictEqual([
    "hooks-compatibility",
    { name: "guard", origin: "local" },
  ]);
  await program.parseAsync(
    ["hooks", "compatibility", "lint", "--origin", "team/web"],
    { from: "user" },
  );
  expect(calls.pop()).toStrictEqual([
    "hooks-compatibility",
    { origin: "team/web", name: "lint" },
  ]);
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
  for (const command of ["compatibility", "adapt"])
    await expect(
      program.parseAsync(["hooks", command], { from: "user" }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof CliError &&
        error.hint === `barndog hooks ${command} <name>`,
    );
  expect(calls.length).toBe(0);
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
  expect(text).toMatch(/Version\s+3/);
  expect(text).toMatch(/Tool\s+Support\s+Ready on this machine/);
  expect(text).toMatch(/claude\s+supported\s+✔/);
  expect(text).toMatch(/codex\s+partial\s+✖ Missing runtime: jq/);
  expect(text).toMatch(/barndog hooks adapt guard --for cursor/);
  expect(text).not.toMatch(/Declared|Tested|No implementation/);
  const local = await run("ac93c0ce639c89b0f4871900b90039c17fd7ffe3");
  expect(local).toMatch(/Version\s+ac93c0c\n/);
  expect(local).not.toMatch(/ac93c0ce/);
});
