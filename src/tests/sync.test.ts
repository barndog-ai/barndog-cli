import { expect, test, type TestContext } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
  lstat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { sync } from "../features/skills/sync.js";
import {
  readSettings,
  saveSettings,
  settingsPath,
} from "../config/settings.js";
import type { Harness } from "../harnesses/registry.js";

const id = "729b9d5a-4a8c-4aa7-9b8d-975a55ac373e";

async function setup(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "barndog-test-")));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const source = join(root, "source", "example");
  const config = settingsPath(home);
  const targets = [
    ".claude/skills/example",
    ".agents/skills/example",
    ".cursor/skills/example",
  ].map((path) => join(home, path));
  await mkdir(join(source, "references"), { recursive: true });
  await writeFile(
    join(source, "SKILL.md"),
    "---\nname: example\ndescription: Example check\n---\nRead references/check.txt\n",
  );
  await writeFile(join(source, "references/check.txt"), "supporting content");
  const skills = [
    { id, source: relative(dirname(config), source), enabled: true },
  ];
  await saveSettings(
    { version: 1, harnesses: ["claude", "codex", "cursor"], skills },
    home,
  );
  const configure = async (enabled: boolean) => {
    const current = (await readSettings(home))!;
    expect(current.version).toBe(1);
    if (current.version !== 1) throw new Error("Expected legacy fixture");
    await saveSettings(
      { ...current, skills: [{ ...skills[0]!, enabled }] },
      home,
    );
  };
  const selectHarnesses = async (harnesses: Harness[]) => {
    await saveSettings({ ...(await readSettings(home))!, harnesses }, home);
  };
  return { root, home, source, config, targets, configure, selectHarnesses };
}

test("all three harness links expose the whole package; repeat sync preserves link and state", async (t) => {
  const f = await setup(t);
  await sync(f.config, f.home);
  const before = await Promise.all(f.targets.map((path) => lstat(path)));
  const state = await readFile(join(f.home, ".barndog/state.json"), "utf8");
  for (const target of f.targets) {
    expect(await readlink(target)).toBe(f.source);
    expect(await readFile(join(target, "references/check.txt"), "utf8")).toBe(
      "supporting content",
    );
  }
  expect(
    (await sync(f.config, f.home)).every((line) => line.type === "unchanged"),
  ).toBeTruthy();
  expect(await readFile(join(f.home, ".barndog/state.json"), "utf8")).toBe(
    state,
  );
  for (const [index, target] of f.targets.entries())
    expect((await lstat(target)).ino).toBe(before[index]!.ino);
  await writeFile(join(f.source, "references/check.txt"), "updated content");
  for (const target of f.targets)
    expect(await readFile(join(target, "references/check.txt"), "utf8")).toBe(
      "updated content",
    );
});

test("disable preserves selection and source; re-enable restores all three links", async (t) => {
  const f = await setup(t);
  await sync(f.config, f.home);
  await f.configure(false);
  await sync(f.config, f.home);
  for (const target of f.targets)
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(f.config, "utf8")).toMatch(/enabled: false/);
  expect(await readFile(join(f.source, "SKILL.md"), "utf8")).toMatch(
    /name: example/,
  );
  await f.configure(true);
  await sync(f.config, f.home);
  for (const target of f.targets) expect(await readlink(target)).toBe(f.source);
});

for (const conflictIndex of [0, 1, 2])
  test(`unmanaged conflict at destination ${conflictIndex} prevents changes to every harness`, async (t) => {
    const f = await setup(t);
    const conflict = f.targets[conflictIndex]!;
    await mkdir(conflict, { recursive: true });
    await writeFile(join(conflict, "keep.txt"), "mine");
    await expect(sync(f.config, f.home)).rejects.toThrow(/unmanaged/);
    for (const target of f.targets.filter((path) => path !== conflict))
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(conflict, "keep.txt"), "utf8")).toBe("mine");
  });

test("existing Claude and Codex state gains Cursor without reinstalling previous links", async (t) => {
  const f = await setup(t);
  await sync(f.config, f.home);
  const statePath = join(f.home, ".barndog/state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.links = state.links.filter(
    (link: { harness: string }) => link.harness !== "cursor",
  );
  await writeFile(statePath, JSON.stringify(state));
  await rm(f.targets[2]!);
  const before = await Promise.all(
    f.targets.slice(0, 2).map((path) => lstat(path)),
  );
  const messages = await sync(f.config, f.home);
  expect(messages.filter((line) => line.type === "unchanged").length).toBe(2);
  expect(
    messages.filter(
      (line) => line.type === "installed" && line.link.harness === "cursor",
    ).length,
  ).toBe(1);
  expect(await readlink(f.targets[2]!)).toBe(f.source);
  for (const [index, target] of f.targets.slice(0, 2).entries())
    expect((await lstat(target)).ino).toBe(before[index]!.ino);
  await sync(f.config, f.home);
});

test("externally replaced managed link is preserved on disable", async (t) => {
  const f = await setup(t);
  await sync(f.config, f.home);
  await rm(f.targets[0]!);
  await symlink(f.root, f.targets[0]!, "dir");
  await f.configure(false);
  await expect(sync(f.config, f.home)).rejects.toThrow(/changed externally/);
  expect(await readlink(f.targets[0]!)).toBe(f.root);
  expect(await readlink(f.targets[1]!)).toBe(f.source);
});

test("invalid skill fails before installation and removed selections clean up", async (t) => {
  const f = await setup(t);
  await writeFile(join(f.source, "SKILL.md"), "missing frontmatter");
  await expect(sync(f.config, f.home)).rejects.toThrow(/Invalid SKILL.md/);
  await writeFile(
    join(f.source, "SKILL.md"),
    "---\nname: example\ndescription: Example\n---\nCheck",
  );
  await sync(f.config, f.home);
  await saveSettings({ ...(await readSettings(f.home))!, skills: [] }, f.home);
  await sync(f.config, f.home);
  for (const target of f.targets)
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

test("missing managed links are repaired; disabled missing sources can be cleaned up", async (t) => {
  const f = await setup(t);
  await sync(f.config, f.home);
  await rm(f.targets[0]!);
  await sync(f.config, f.home);
  expect(await readlink(f.targets[0]!)).toBe(f.source);
  await rm(f.source, { recursive: true });
  await f.configure(false);
  await sync(f.config, f.home);
  for (const target of f.targets)
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

test("sync targets only selected harnesses and reconciles deselection without losing skill selections", async (t) => {
  const f = await setup(t);
  await f.selectHarnesses(["codex"]);
  await sync(f.config, f.home);
  await expect(lstat(f.targets[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(f.targets[2]!)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readlink(f.targets[1]!)).toBe(f.source);
  const selected = (await readSettings(f.home))!.skills;
  await f.selectHarnesses(["claude", "cursor"]);
  await sync(f.config, f.home);
  await expect(lstat(f.targets[1]!)).rejects.toMatchObject({ code: "ENOENT" });
  for (const index of [0, 2])
    expect(await readlink(f.targets[index]!)).toBe(f.source);
  await f.selectHarnesses([]);
  await sync(f.config, f.home);
  for (const target of f.targets)
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readSettings(f.home))!.skills).toStrictEqual(selected);
  expect(await readFile(join(f.source, "SKILL.md"), "utf8")).toMatch(
    /name: example/,
  );
});

test("sync requires onboarding and rejects invalid settings before touching links", async (t) => {
  const f = await setup(t);
  const settings = settingsPath(f.home);
  const original = await readFile(settings, "utf8");
  await rm(settings);
  await expect(sync(f.config, f.home)).rejects.toMatchObject({
    name: "SetupRequiredError",
  });
  for (const target of f.targets)
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(settings, original);
  await f.selectHarnesses(["codex"]);
  await sync(f.config, f.home);
  await writeFile(settings, "version: 1\nharnesses: [typo]\n");
  await expect(sync(f.config, f.home)).rejects.toThrow(/Invalid user settings/);
  expect(await readlink(f.targets[1]!)).toBe(f.source);
});

test("default sync uses the home config and shared state regardless of working directory", async (t) => {
  const f = await setup(t);
  const unrelated = join(f.root, "unrelated");
  await mkdir(unrelated);
  // This deliberately invalid local file must never be used by default.
  await writeFile(join(unrelated, "barndog.yaml"), "not the configuration");
  const previousDirectory = process.cwd();
  try {
    process.chdir(unrelated);
    await sync(undefined, f.home);
    const before = await Promise.all(f.targets.map((target) => lstat(target)));
    process.chdir(f.source);
    const messages = await sync(undefined, f.home);
    expect(messages.filter((line) => line.type === "unchanged").length).toBe(3);
    for (const [index, target] of f.targets.entries())
      expect((await lstat(target)).ino).toBe(before[index]!.ino);
    await readFile(join(f.home, ".barndog/state.json"));
    await expect(lstat(join(unrelated, ".barndog"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    process.chdir(previousDirectory);
  }
});

test("explicit config override includes harnesses and skills but shares machine installation state", async (t) => {
  const f = await setup(t);
  await sync(undefined, f.home);
  const override = join(f.root, "override.yaml");
  await writeFile(
    override,
    `version: 1\nharnesses: [codex]\nskills:\n  - id: ${id}\n    source: ./source/example\n    enabled: true\n`,
  );
  await sync(override, f.home);
  await expect(lstat(f.targets[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(f.targets[2]!)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readlink(f.targets[1]!)).toBe(f.source);
  await sync(undefined, f.home);
  for (const target of f.targets) expect(await readlink(target)).toBe(f.source);
});
