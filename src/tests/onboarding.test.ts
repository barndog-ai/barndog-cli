import { POSIX_MODE } from "../shared/constants.js";

import { assert, expect, test, type TestContext } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { built } from "./built.js";
import { detectHarnesses } from "../harnesses/detect.js";
import { initialize } from "../features/onboarding/setup.js";
import { runSetup } from "../ui/onboarding.js";
import { readSettings, saveSettings } from "../config/settings.js";
import { barndogPaths } from "../config/paths.js";

async function setup(t: TestContext) {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "barndog-onboarding-")),
  );

  t.onTestFinished(() => rm(home, { recursive: true, force: true }));

  return home;
}

test("detection uses executable PATH entries and macOS app installations, not skill directories", async (t) => {
  const home = await setup(t);
  const bin = join(home, "bin");
  const apps = join(home, "Applications");
  await mkdir(bin);
  await writeFile(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bin, "codex"), POSIX_MODE.executableFile);
  await writeFile(join(bin, "claude"), "not executable");
  await mkdir(join(apps, "Cursor.app", "Contents", "MacOS"), {
    recursive: true,
  });

  await mkdir(join(home, ".claude", "skills"), { recursive: true });
  const found = await detectHarnesses({
    home,
    path: bin,
    platform: "darwin",
    appDirectories: [apps],
  });

  expect(found.find((item) => item.id === "claude")!.evidence).toBe(null);
  expect(found.find((item) => item.id === "codex")!.evidence).toBe(
    join(bin, "codex"),
  );

  expect(found.find((item) => item.id === "cursor")!.evidence).toBe(
    join(apps, "Cursor.app"),
  );
});

test("first onboarding requires explicit selection and saves machine settings; re-init keeps choices", async (t) => {
  const home = await setup(t);
  const detected = await detectHarnesses({ home, path: "", platform: "linux" });
  await initialize({
    home,
    detected,
    choose: async (choices) => {
      expect(choices.every((choice) => !choice.checked)).toBeTruthy();
      expect(choices.every((choice) => choice.evidence === null)).toBeTruthy();

      return ["codex"];
    },
  });

  expect(await readSettings(home)).toStrictEqual({
    harnesses: ["codex"],
  });

  await initialize({
    home,
    detected,
    choose: async (choices) => {
      expect(choices.find((choice) => choice.value === "codex")!.checked).toBe(
        true,
      );

      expect(choices.find((choice) => choice.value === "claude")!.checked).toBe(
        false,
      );

      return ["claude", "codex"];
    },
  });

  expect((await readSettings(home))!.harnesses).toStrictEqual([
    "claude",
    "codex",
  ]);
});

test("cancelling onboarding preserves previous settings or leaves first-time setup absent", async (t) => {
  const home = await setup(t);
  const detected = await detectHarnesses({ home, path: "", platform: "linux" });
  const choose = async (): Promise<never> => {
    throw new Error("cancelled");
  };

  await expect(initialize({ home, detected, choose })).rejects.toThrow(
    /cancelled/,
  );

  expect(await readSettings(home)).toBe(null);
  await saveSettings({ harnesses: ["cursor"] }, home);
  const original = await readFile(barndogPaths(home).settings, "utf8");
  await expect(initialize({ home, detected, choose })).rejects.toThrow(
    /cancelled/,
  );

  expect(await readFile(barndogPaths(home).settings, "utf8")).toBe(original);
});

test("empty selection persists and invalid settings never default to all harnesses", async (t) => {
  const home = await setup(t);
  await saveSettings({ harnesses: [] }, home);
  expect(await readSettings(home)).toStrictEqual({
    harnesses: [],
  });

  for (const content of [
    "harnesses: [unknown]\n",
    "harnesses: [codex, codex]\n",
    "skills: []\n",
  ]) {
    await writeFile(barndogPaths(home).settings, content);
    await expect(readSettings(home)).rejects.toThrow(
      /isn't valid: harnesses must list/,
    );
  }
});

test("CLI help is noninteractive; explicit onboarding refuses piped input without hanging", () => {
  const executable = built("cli.js");
  const help = execFileSync(process.execPath, [executable, "--help"], {
    encoding: "utf8",
  });

  expect(help).toMatch(/init/);
  for (const args of [["init"]]) {
    const result = spawnSync(process.execPath, [executable, ...args], {
      encoding: "utf8",
      timeout: 5000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/interactive terminal/);
  }
});

test("bare invocation reports existing configuration without prompting or rewriting it", async (t) => {
  const home = await setup(t);
  await saveSettings({ harnesses: ["codex"] }, home);
  const original = await readFile(barndogPaths(home).settings, "utf8");
  const messages: string[] = [];
  await runSetup({
    home,
    interactive: false,
    write: (message) => messages.push(message),
    choose: async () => {
      throw new Error("Must not prompt");
    },
    confirmRestart: async () => {
      throw new Error("Must not confirm");
    },
  });

  expect(messages.join("\n")).toMatch(/Configuration already exists/);
  expect(messages.join("\n")).toMatch(/barndog init/);
  expect(await readFile(barndogPaths(home).settings, "utf8")).toBe(original);
});

test("declining or cancelling restart leaves the configuration untouched", async (t) => {
  const home = await setup(t);
  await saveSettings({ harnesses: ["codex"] }, home);
  const original = await readFile(barndogPaths(home).settings, "utf8");
  const messages: string[] = [];
  const options = {
    home,
    restart: true,
    interactive: true,
    write: (message: string) => messages.push(message),
    choose: async (): Promise<never> => {
      throw new Error("Must not select harnesses");
    },
  };

  await runSetup({ ...options, confirmRestart: async () => false });
  expect(messages.join("\n")).toMatch(/Configuration was not changed/);
  await expect(
    runSetup({
      ...options,
      confirmRestart: async () => {
        throw new Error("cancelled");
      },
    }),
  ).rejects.toThrow(/cancelled/);

  expect(await readFile(barndogPaths(home).settings, "utf8")).toBe(original);
});

test("confirmed restart reopens harness selection while preserving saved settings", async (t) => {
  const home = await setup(t);
  await saveSettings({ harnesses: ["codex"], knowledge: false }, home);
  let confirmed = false;
  await runSetup({
    home,
    restart: true,
    interactive: true,
    local: true,
    confirmApply: async () => true,
    write: () => {},
    confirmRestart: async () => {
      confirmed = true;

      return true;
    },
    detected: [{ id: "codex", name: "Codex", evidence: "/bin/codex" }],
    choose: async (choices) => {
      expect(confirmed).toBe(true);
      expect(choices[0]!.checked).toBe(true);

      return ["claude"];
    },
  });

  const saved = await readSettings(home);
  expect(saved?.harnesses).toStrictEqual(["claude"]);
  expect(saved?.knowledge).toBe(false);
  expect(saved?.localWorkspace?.path).toBe(join(home, ".barndog/workspace"));
});

test("first setup skips restart confirmation and still requires an interactive terminal", async (t) => {
  const home = await setup(t);
  await expect(runSetup({ home, interactive: false })).rejects.toThrow(
    /interactive terminal/,
  );

  await runSetup({
    home,
    restart: true,
    interactive: true,
    local: true,
    confirmApply: async () => true,
    write: () => {},
    detected: [],
    confirmRestart: async () => {
      throw new Error("First setup must not ask to restart");
    },
    choose: async () => ["codex"],
  });

  const saved = await readSettings(home);
  expect(saved?.harnesses).toStrictEqual(["codex"]);
  assert(saved?.localWorkspace);
});

test("reinitializing harness selection preserves the rest of the home configuration", async (t) => {
  const home = await setup(t);
  await saveSettings({ harnesses: ["codex"], knowledge: false }, home);
  expect(barndogPaths(home).settings).toBe(join(home, ".barndog/config.yaml"));
  await initialize({ home, detected: [], choose: async () => ["claude"] });
  expect(await readSettings(home)).toStrictEqual({
    harnesses: ["claude"],
    knowledge: false,
  });
});
