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
import { expect, test, vi, type TestContext } from "vitest";

import { readSettings } from "../config/settings.js";
import {
  changeHarnesses,
  listHarnesses,
  selectHarnesses,
} from "../features/environment/harnesses.js";
import { synchronize } from "../features/environment/sync.js";
import { SetupRequiredError } from "../config/settings.js";
import { createProgram, type ProgramOptions } from "../program.js";
import { type AddContext } from "../ui/add-asset.js";
import { addSkills } from "../ui/add-skills.js";
import { chooseHarnesses } from "../ui/harness-picker.js";
import { runSetup } from "../ui/onboarding.js";
import { testRuntime } from "./runtime.js";

vi.mock("../ui/harness-picker.js", () => ({ chooseHarnesses: vi.fn() }));

const plain = (lines: string[]) =>
  // eslint-disable-next-line no-control-regex
  lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");

/** A local workspace managing Claude Code and Codex, with one Skill installed. */
async function setUp(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "barndog-harnesses-")),
  );

  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await runSetup({
    runtime: testRuntime(home),
    local: true,
    restart: true,
    interactive: true,
    detected: [],
    write: () => {},
    confirmRestart: async () => true,
    confirmApply: async () => true,
    choose: async () => ["claude", "codex"],
  });

  const source = join(root, "source", "review");
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, "SKILL.md"),
    "---\nname: review\ndescription: Reviews\n---\nBody\n",
  );

  const quiet: AddContext = {
    runtime: testRuntime(home),
    interactive: false,
    write: () => {},
    prompts: {} as AddContext["prompts"],
  };

  await addSkills(source, { copy: true }, quiet);
  await synchronize(undefined, testRuntime(home));

  return {
    home,
    claudeSkill: join(home, ".claude/skills/review"),
    codexSkill: join(home, ".agents/skills/review"),
    claudeSettings: join(home, ".claude/settings.json"),
  };
}

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

test("disabling a coding tool removes what BarnDog installed there and later syncs leave it alone", async (t) => {
  const { home, claudeSkill, codexSkill, claudeSettings } = await setUp(t);
  const runtime = testRuntime(home);
  expect(existsSync(claudeSkill)).toBe(true);
  expect(existsSync(codexSkill)).toBe(true);
  expect(await readFile(claudeSettings, "utf8")).toMatch(/workspace-startup/);

  const disabled = await changeHarnesses("disable", ["claude"], runtime);
  expect(disabled.harnesses).toEqual(["codex"]);
  expect((await readSettings(home))?.harnesses).toEqual(["codex"]);
  expect(existsSync(claudeSkill)).toBe(false);
  expect(await readFile(claudeSettings, "utf8")).not.toMatch(
    /workspace-startup/,
  );

  expect(existsSync(codexSkill)).toBe(true);

  await synchronize(undefined, runtime);
  expect(existsSync(claudeSkill)).toBe(false);

  const listed = await listHarnesses(runtime);
  expect(listed.map((row) => [row.id, row.enabled])).toEqual([
    ["claude", false],
    ["codex", true],
    ["cursor", false],
    ["opencode", false],
  ]);

  // Claude Code goes back in front, as the registry lists it.
  await changeHarnesses("enable", ["claude"], runtime);
  expect((await readSettings(home))?.harnesses).toEqual(["claude", "codex"]);
  expect(existsSync(claudeSkill)).toBe(true);

  await selectHarnesses([], runtime);
  expect((await readSettings(home))?.harnesses).toEqual([]);
  expect(existsSync(claudeSkill)).toBe(false);
  expect(existsSync(codexSkill)).toBe(false);
});

test("harness commands need setup", async (t) => {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "barndog-harnesses-")),
  );

  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const runtime = testRuntime(home);

  await expect(listHarnesses(runtime)).rejects.toBeInstanceOf(
    SetupRequiredError,
  );

  await expect(
    changeHarnesses("enable", ["claude"], runtime),
  ).rejects.toBeInstanceOf(SetupRequiredError);
});

test("harnesses commands pass their tools through and confirm what is managed", async () => {
  const changeHarnesses = vi.fn(async () => ({
    status: "applied" as const,
    events: [],
    harnesses: ["codex" as const],
  }));

  const listHarnesses = vi.fn(async () => [
    {
      id: "claude" as const,
      name: "Claude Code",
      evidence: "/bin/claude",
      enabled: false,
    },
    { id: "codex" as const, name: "Codex", evidence: null, enabled: true },
  ]);

  const { instance, output } = program({ changeHarnesses, listHarnesses });
  await instance.parseAsync(["harnesses", "disable", "claude", "cursor"], {
    from: "user",
  });

  expect(changeHarnesses).toHaveBeenCalledWith("disable", ["claude", "cursor"]);
  expect(plain(output)).toMatch(/BarnDog now manages Codex\./);

  output.length = 0;
  await instance.parseAsync(["harnesses"], { from: "user" });
  expect(plain(output)).toMatch(/claude\s+Claude Code\s+off\s+\/bin\/claude/);
  expect(plain(output)).toMatch(/codex\s+Codex\s+managed\s+not found/);
});

test("harnesses enable rejects unknown tools and needs at least one", async () => {
  const changeHarnesses = vi.fn();
  for (const args of [["enable", "vim"], ["enable"]]) {
    const { instance } = program({ changeHarnesses });
    await expect(
      instance.parseAsync(["harnesses", ...args], { from: "user" }),
    ).rejects.toThrow();
  }

  expect(changeHarnesses).not.toHaveBeenCalled();
});

test("harnesses disable with no tools named picks from the managed ones, and enable from the rest", async () => {
  const changeHarnesses = vi.fn(async () => ({
    status: "applied" as const,
    events: [],
    harnesses: [],
  }));

  const listHarnesses = vi.fn(async () => [
    {
      id: "claude" as const,
      name: "Claude Code",
      evidence: null,
      enabled: true,
    },
    { id: "codex" as const, name: "Codex", evidence: null, enabled: false },
    {
      id: "opencode" as const,
      name: "OpenCode",
      evidence: null,
      enabled: true,
    },
  ]);

  await expect(
    program({ changeHarnesses, listHarnesses }).instance.parseAsync(
      ["harnesses", "disable"],
      { from: "user" },
    ),
  ).rejects.toThrow(/Name the coding tools to disable/);

  for (const [change, offered] of [
    ["disable", ["claude", "opencode"]],
    ["enable", ["codex"]],
  ] as const) {
    vi.mocked(chooseHarnesses).mockClear();
    vi.mocked(chooseHarnesses).mockResolvedValue(["opencode"]);
    const { instance } = program({
      changeHarnesses,
      listHarnesses,
      interactive: true,
    });

    await instance.parseAsync(["harnesses", change], { from: "user" });
    const [choices, question] = vi.mocked(chooseHarnesses).mock.calls[0]!;
    expect(choices.map((choice) => [choice.value, choice.checked])).toEqual(
      offered.map((id) => [id, false]),
    );

    expect(question).toMatchObject({ required: true });
    expect(changeHarnesses).toHaveBeenLastCalledWith(change, ["opencode"]);
  }
});

test("harnesses disable with nothing managed says so instead of opening an empty picker", async () => {
  vi.mocked(chooseHarnesses).mockClear();
  const { instance } = program({
    changeHarnesses: vi.fn(),
    listHarnesses: vi.fn(async () => [
      {
        id: "claude" as const,
        name: "Claude Code",
        evidence: null,
        enabled: false,
      },
    ]),
    interactive: true,
  });

  await expect(
    instance.parseAsync(["harnesses", "disable"], { from: "user" }),
  ).rejects.toThrow(/doesn't manage any coding tool/);

  expect(chooseHarnesses).not.toHaveBeenCalled();
});

test("harnesses select needs a terminal, then saves exactly the checked tools", async () => {
  const selectHarnesses = vi.fn(async () => ({
    status: "applied" as const,
    events: [],
    harnesses: [],
  }));

  const listHarnesses = vi.fn(async () => [
    {
      id: "claude" as const,
      name: "Claude Code",
      evidence: null,
      enabled: true,
    },
    { id: "codex" as const, name: "Codex", evidence: null, enabled: false },
  ]);

  await expect(
    program({ selectHarnesses, listHarnesses }).instance.parseAsync(
      ["harnesses", "select"],
      { from: "user" },
    ),
  ).rejects.toThrow(/needs a terminal/);

  vi.mocked(chooseHarnesses).mockResolvedValue([]);
  const { instance, output } = program({
    selectHarnesses,
    listHarnesses: vi.fn(async () =>
      (await listHarnesses()).map((row) => ({ ...row, enabled: false })),
    ),
    interactive: true,
  });

  await instance.parseAsync(["harnesses", "select"], { from: "user" });
  const offered = vi.mocked(chooseHarnesses).mock.calls[0]![0];
  expect(offered.map((choice) => [choice.value, choice.checked])).toEqual([
    ["claude", false],
    ["codex", false],
  ]);

  expect(selectHarnesses).toHaveBeenCalledWith([]);
  expect(plain(output)).toMatch(/no longer manages any coding tool/);
});
