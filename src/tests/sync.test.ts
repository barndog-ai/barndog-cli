import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type TestContext } from "vitest";

import {
  saveSettings,
  settingsPath,
  SetupRequiredError,
} from "../config/settings.js";
import { synchronize } from "../features/environment/sync.js";

async function temporaryHome(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "barndog-sync-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  return home;
}

test("sync needs setup and refuses invalid settings before writing anything", async (t) => {
  const home = await temporaryHome(t);
  await expect(synchronize(undefined, home)).rejects.toBeInstanceOf(
    SetupRequiredError,
  );
  await mkdir(join(home, ".barndog"), { recursive: true });
  await writeFile(settingsPath(home), "harnesses: [typo]\n");
  await expect(synchronize(undefined, home)).rejects.toThrow(
    /Invalid user settings/,
  );
  await expect(lstat(join(home, ".barndog/state.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("an explicit config file is read instead and never changes the home configuration", async (t) => {
  const home = await temporaryHome(t);
  await saveSettings({ harnesses: ["claude"] }, home);
  const before = await readFile(settingsPath(home), "utf8");
  const override = join(home, "override.yaml");
  await writeFile(override, "harnesses: [codex]\n");
  await synchronize(override, home);
  expect(await readFile(settingsPath(home), "utf8")).toBe(before);
});
