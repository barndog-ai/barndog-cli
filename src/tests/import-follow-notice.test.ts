import { expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import { cloud } from "./cloud.js";
import { testRuntime } from "./runtime.js";
import { localWorkspace } from "../features/workspace/setup.js";
import { readSettings, saveSettings } from "../config/settings.js";
import { localWorkspaceFiles } from "../config/paths.js";

test("a sync that can't read the local folder's import records says updates weren't checked, and still finishes", async (t) => {
  const server = await cloud(t, { harnesses: ["claude"] });
  const local = await localWorkspace(testRuntime(server.home));
  const settings = (await readSettings(server.home))!;
  await saveSettings({ ...settings, localWorkspace: local }, server.home);
  await writeFile(localWorkspaceFiles(local.path).sources, "{ damaged");

  const output = await server.run(["sync"]);

  expect(output).toContain(
    `! Imported assets weren't checked for updates, because ${localWorkspaceFiles(local.path).sources} couldn't be read:`,
  );

  expect(output).toContain("Sync complete");
});
