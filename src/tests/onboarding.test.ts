import { test } from "node:test";
import assert from "node:assert/strict";
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
import { detectHarnesses } from "../harnesses/detect.js";
import { initialize } from "../features/onboarding/setup.js";
import { runSetup } from "../ui/onboarding.js";
import {
  readSettings,
  saveSettings,
  settingsPath,
} from "../config/settings.js";

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "barndog-onboarding-")),
  );
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test("detection uses executable PATH entries and macOS app installations, not skill directories", async (t) => {
  const home = await setup(t);
  const bin = join(home, "bin");
  const apps = join(home, "Applications");
  await mkdir(bin);
  await writeFile(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bin, "codex"), 0o755);
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
  assert.equal(found.find((item) => item.id === "claude")!.evidence, null);
  assert.equal(
    found.find((item) => item.id === "codex")!.evidence,
    join(bin, "codex"),
  );
  assert.equal(
    found.find((item) => item.id === "cursor")!.evidence,
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
      assert.ok(choices.every((choice) => !choice.checked));
      assert.ok(choices.every((choice) => choice.evidence === null));
      return ["codex"];
    },
  });
  assert.deepEqual(await readSettings(home), {
    version: 1,
    harnesses: ["codex"],
    skills: [],
  });
  await initialize({
    home,
    detected,
    choose: async (choices) => {
      assert.equal(
        choices.find((choice) => choice.value === "codex")!.checked,
        true,
      );
      assert.equal(
        choices.find((choice) => choice.value === "claude")!.checked,
        false,
      );
      return ["claude", "codex"];
    },
  });
  assert.deepEqual((await readSettings(home))!.harnesses, ["claude", "codex"]);
});

test("cancelling onboarding preserves previous settings or leaves first-time setup absent", async (t) => {
  const home = await setup(t);
  const detected = await detectHarnesses({ home, path: "", platform: "linux" });
  const choose = async (): Promise<never> => {
    throw new Error("cancelled");
  };
  await assert.rejects(initialize({ home, detected, choose }), /cancelled/);
  assert.equal(await readSettings(home), null);
  await saveSettings({ version: 1, harnesses: ["cursor"], skills: [] }, home);
  const original = await readFile(settingsPath(home), "utf8");
  await assert.rejects(initialize({ home, detected, choose }), /cancelled/);
  assert.equal(await readFile(settingsPath(home), "utf8"), original);
});

test("empty selection persists and invalid settings never default to all harnesses", async (t) => {
  const home = await setup(t);
  await saveSettings({ version: 1, harnesses: [], skills: [] }, home);
  assert.deepEqual(await readSettings(home), {
    version: 1,
    harnesses: [],
    skills: [],
  });
  for (const content of [
    "version: 1\nharnesses: [unknown]\n",
    "version: 1\nharnesses: [codex, codex]\n",
    "skills: []\n",
  ]) {
    await writeFile(settingsPath(home), content);
    await assert.rejects(readSettings(home), /Invalid user settings/);
  }
});

test("CLI help is noninteractive; explicit onboarding refuses piped input without hanging", () => {
  const executable = new URL("../cli.js", import.meta.url);
  const help = execFileSync(process.execPath, [executable.pathname, "--help"], {
    encoding: "utf8",
  });
  assert.match(help, /init/);
  for (const args of [["init"]]) {
    const result = spawnSync(process.execPath, [executable.pathname, ...args], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /interactive terminal/);
  }
});

test("bare invocation reports existing configuration without prompting or rewriting it", async (t) => {
  const home = await setup(t);
  await saveSettings({ version: 1, harnesses: ["codex"], skills: [] }, home);
  const original = await readFile(settingsPath(home), "utf8");
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
  assert.match(messages.join("\n"), /Configuration already exists/);
  assert.match(messages.join("\n"), /barndog init/);
  assert.equal(await readFile(settingsPath(home), "utf8"), original);
});

test("declining or cancelling restart leaves the configuration untouched", async (t) => {
  const home = await setup(t);
  await saveSettings({ version: 1, harnesses: ["codex"], skills: [] }, home);
  const original = await readFile(settingsPath(home), "utf8");
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
  assert.match(messages.join("\n"), /Configuration was not changed/);
  await assert.rejects(
    runSetup({
      ...options,
      confirmRestart: async () => {
        throw new Error("cancelled");
      },
    }),
    /cancelled/,
  );
  assert.equal(await readFile(settingsPath(home), "utf8"), original);
});

test("confirmed restart reopens harness selection while preserving saved skills", async (t) => {
  const home = await setup(t);
  const skills = [
    {
      id: "729b9d5a-4a8c-4aa7-9b8d-975a55ac373e",
      source: "./skills/example",
      enabled: false,
    },
  ];
  await saveSettings({ version: 1, harnesses: ["codex"], skills }, home);
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
      assert.equal(confirmed, true);
      assert.equal(choices[0]!.checked, true);
      return ["claude"];
    },
  });
  const saved = await readSettings(home);
  assert.equal(saved?.version, 2);
  assert.deepEqual(saved?.harnesses, ["claude"]);
  assert.deepEqual(saved?.skills, [{ ...skills[0]!, kind: "local" }]);
  assert.equal(
    saved?.version === 2 && saved.localWorkspace?.path,
    join(home, ".barndog/workspace"),
  );
});

test("first setup skips restart confirmation and still requires an interactive terminal", async (t) => {
  const home = await setup(t);
  await assert.rejects(
    runSetup({ home, interactive: false }),
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
  assert.deepEqual(saved?.harnesses, ["codex"]);
  assert.deepEqual(saved?.skills, []);
  assert.ok(saved?.version === 2 && saved.localWorkspace);
});

test("reinitializing harness selection preserves skills in the home configuration", async (t) => {
  const home = await setup(t);
  const skills = [
    {
      id: "729b9d5a-4a8c-4aa7-9b8d-975a55ac373e",
      source: "./skills/example",
      enabled: false,
    },
  ];
  await saveSettings({ version: 1, harnesses: ["codex"], skills }, home);
  assert.equal(settingsPath(home), join(home, ".barndog/config.yaml"));
  await initialize({ home, detected: [], choose: async () => ["claude"] });
  assert.deepEqual(await readSettings(home), {
    version: 1,
    harnesses: ["claude"],
    skills,
  });
});
