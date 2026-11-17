import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi, type TestContext } from "vitest";
import { saveSettings } from "../config/settings.js";
import { CliError } from "../errors.js";
import { localWorkspace } from "../features/workspace/setup.js";
import type { MigrationReport } from "../features/migration/migrate.js";
import { createProgram } from "../program.js";
import { built } from "./built.js";
import { testRuntime } from "./runtime.js";

const SKILL = "---\nname: review\ndescription: Reviews\n---\nBody\n";

/** A temporary home with a real local workspace folder holding one Skill and a knowledge document. */
async function localHome(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "barndog-workspace-"));
  const local = await localWorkspace(testRuntime(home));
  await saveSettings({ harnesses: [], localWorkspace: local }, home);
  await mkdir(join(local.path, "org/skills/review"), { recursive: true });
  await writeFile(join(local.path, "org/skills/review/SKILL.md"), SKILL);
  await mkdir(join(local.path, "org/skills/notes"), { recursive: true });
  await writeFile(
    join(local.path, "org/skills/notes/SKILL.md"),
    SKILL.replaceAll("review", "notes"),
  );

  await mkdir(join(local.path, "org/knowledge"), { recursive: true });
  await writeFile(
    join(local.path, "org/knowledge/context.md"),
    "---\ndescription: Context\n---\nText\n",
  );

  t.onTestFinished(() => rm(home, { recursive: true, force: true }));

  return { home, folder: local.path };
}

async function runCommand(home: string, args: string[]) {
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

test("validate reports the workspace name and counts", async (t) => {
  const { home, folder } = await localHome(t);
  const { output, failure } = await runCommand(home, ["validate", folder]);

  expect(failure).toBeUndefined();
  expect(output).toEqual([
    "✔ My workspace is valid · 2 assets, 1 knowledge document",
  ]);
});

test("validate --json prints the summary", async (t) => {
  const { home, folder } = await localHome(t);
  const { output } = await runCommand(home, ["validate", folder, "--json"]);

  expect(JSON.parse(output.join("\n"))).toEqual({
    workspace: "My workspace",
    assets: 2,
    knowledge: 1,
  });
});

test("validate checks the current folder unless given another", async () => {
  const validateFolder = vi
    .fn()
    .mockResolvedValue({ workspace: "Acme", assets: 1, knowledge: 0 });

  const write = vi.fn();
  const program = () => createProgram({ validateFolder, write });
  await program().parseAsync(["validate"], { from: "user" });
  expect(validateFolder).toHaveBeenLastCalledWith(".");

  await program().parseAsync(["validate", "assets"], { from: "user" });
  expect(validateFolder).toHaveBeenLastCalledWith("assets");
  expect(write).toHaveBeenLastCalledWith(
    "✔ Acme is valid · 1 asset, 0 knowledge documents",
  );
});

test("validate fails with the problems found", async (t) => {
  const { home, folder } = await localHome(t);
  await mkdir(join(folder, "org/skills/broken"), { recursive: true });
  await writeFile(join(folder, "org/skills/broken/SKILL.md"), "invalid");

  const { output, failure } = await runCommand(home, ["validate", folder]);

  expect(output).toEqual([]);
  expect(failure).toBeInstanceOf(CliError);
  expect((failure as CliError).message).toBe(
    "1 problem found:\n  org/skills/broken: SKILL.md needs front matter with a lowercase hyphenated name and a description",
  );

  expect((failure as CliError).hint).toBe(
    "Fix the files listed, then validate again",
  );
});

test("validate exits non-zero when the workspace has problems", async (t) => {
  const { home, folder } = await localHome(t);
  await mkdir(join(folder, "org/skills/broken"), { recursive: true });
  await writeFile(join(folder, "org/skills/broken/SKILL.md"), "invalid");

  const result = spawnSync(
    process.execPath,
    [built("cli.js"), "validate", folder],
    { encoding: "utf8", timeout: 10_000, env: { ...process.env, HOME: home } },
  );

  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("1 problem found");
  expect(result.stderr).toContain("Fix the files listed, then validate again");
});

test("local list shows the folder and each asset with its state", async (t) => {
  const { home, folder } = await localHome(t);
  await mkdir(join(folder, "org/skills/broken"), { recursive: true });
  await writeFile(join(folder, "org/skills/broken/SKILL.md"), "invalid");

  const { output } = await runCommand(home, ["local", "list"]);

  expect(output).toEqual([
    folder,
    "  Name     Kind       State    Path",
    "  broken   skill      invalid  org/skills/broken",
    "  notes    skill      active   org/skills/notes",
    "  review   skill      active   org/skills/review",
    "  context  knowledge  active   org/knowledge/context.md",
  ]);
});

test("local list --json prints the folder and assets", async (t) => {
  const { home, folder } = await localHome(t);
  const { output } = await runCommand(home, ["local", "list", "--json"]);

  expect(JSON.parse(output.join("\n"))).toEqual({
    folder,
    assets: [
      {
        kind: "skill",
        name: "notes",
        path: "org/skills/notes",
        state: "active",
      },
      {
        kind: "skill",
        name: "review",
        path: "org/skills/review",
        state: "active",
      },
      {
        kind: "knowledge",
        name: "context",
        path: "org/knowledge/context.md",
        state: "active",
      },
    ],
  });
});

test("local list says when the folder is empty", async (t) => {
  const { home, folder } = await localHome(t);
  await rm(join(folder, "org"), { recursive: true });

  const { output } = await runCommand(home, ["local", "list"]);

  expect(output).toEqual([folder, "No local assets."]);
});

test("local list without a local workspace tells you to set one up", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "barndog-workspace-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  await saveSettings({ harnesses: [] }, home);

  const { output, failure } = await runCommand(home, ["local", "list"]);

  expect(output).toEqual([]);
  expect(failure).toBeInstanceOf(CliError);
  expect(failure).toMatchObject({
    message: "This machine has no local assets.",
    hint: "barndog init --local",
  });
});

const migration: MigrationReport = {
  server: "https://example.test",
  dryRun: false,
  migrated: true,
  rows: [
    { name: "one", kind: "skill", origin: "org", action: "publish" },
    { name: "two", kind: "mcp", origin: "org", action: "exists" },
  ],
};

const dryRunMigration: MigrationReport = {
  server: "https://example.test",
  dryRun: true,
  migrated: false,
  rows: [
    ...migration.rows,
    {
      name: "three",
      kind: "hook",
      origin: "team/web",
      action: "missing-scope",
      detail: "Create scope",
    },
    {
      name: "four",
      kind: "skill",
      origin: "org",
      action: "invalid",
      detail: "Invalid manifest",
    },
  ],
};

async function runMigrate(report: MigrationReport, args: string[]) {
  const migrate = vi.fn().mockResolvedValue(report);
  const write = vi.fn();
  await createProgram({ migrate, write }).parseAsync(
    ["migrate", "--to", report.server, ...args],
    { from: "user" },
  );

  return { migrate, output: write.mock.calls.map(([line]) => line as string) };
}

test("migrate lists each asset and says the machine now uses the server", async () => {
  const { migrate, output } = await runMigrate(migration, []);

  expect(migrate).toHaveBeenCalledWith({
    server: "https://example.test",
    dryRun: undefined,
  });

  expect(output).toEqual([
    "\nBarnDog migrate\n",
    "  Action   Kind   Name  Origin",
    "  publish  skill  one   org",
    "  exists   mcp    two   org",
    "",
    "✔ This machine now uses https://example.test. Only current content moved; older versions stay in your repo.",
  ]);
});

test("migrate --dry-run shows problems and changes nothing", async () => {
  const { migrate, output } = await runMigrate(dryRunMigration, ["--dry-run"]);

  expect(migrate).toHaveBeenCalledWith({
    server: "https://example.test",
    dryRun: true,
  });

  expect(output).toEqual([
    "\nBarnDog migrate --dry-run\n",
    "  Action         Kind   Name   Origin",
    "  publish        skill  one    org",
    "  exists         mcp    two    org",
    "  missing-scope  hook   three  team/web  Create scope",
    "  invalid        skill  four   org       Invalid manifest",
    "",
    "Nothing was changed.",
  ]);
});

test("migrate --json prints the report", async () => {
  const { output } = await runMigrate(dryRunMigration, ["--dry-run", "--json"]);

  expect(JSON.parse(output.join("\n"))).toEqual(dryRunMigration);
});
