import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type TestContext } from "vitest";
import { CliError } from "../errors.js";
import { inputFile, inputJson } from "../shared/files.js";
import { localWorkspace } from "../features/workspace/setup.js";
import { CONFIG_FILE, parseConfig } from "../features/workspace/format.js";
import { gitSnapshot } from "../features/workspace/snapshot.js";
import { testRuntime } from "./runtime.js";

async function folder(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "barndog-input-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));

  return root;
}

test("a file named on the command line that is missing, a folder or not JSON says which", async (t) => {
  const root = await folder(t);
  const missing = join(root, "missing.json");
  const broken = join(root, "broken.json");
  await writeFile(broken, "{");

  for (const [read, message] of [
    [() => inputFile(missing), `${missing} doesn't exist.`],
    [() => inputFile(root), `${root} is a folder, not a file.`],
    [() => inputJson(broken), `${broken} isn't valid JSON.`],
  ] as const) {
    const failure = await read().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toHaveProperty("message", message);
  }

  await writeFile(broken, '{"ok":true}');
  expect(await inputJson(broken)).toEqual({ ok: true });
});

test("a local workspace whose first creation stopped part way is finished, keeping what was written", async (t) => {
  const path = join(await folder(t), "workspace");
  await mkdir(path);
  await writeFile(join(path, "README.md"), "my notes");

  const local = await localWorkspace(testRuntime(path), path);

  expect(await readFile(join(path, "README.md"), "utf8")).toBe("my notes");
  const config = parseConfig(await readFile(join(path, CONFIG_FILE), "utf8"));
  expect(config.workspaceId).toBe(local.workspaceId);
});

test("reading a Git object the repository doesn't have fails instead of returning wrong bytes", async (t) => {
  const repo = await folder(t);
  const git = (...args: string[]) =>
    spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" }).stdout.trim();

  git("init", "-q");
  await writeFile(join(repo, "a.txt"), "first");
  git("add", "a.txt");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "init",
  );

  const snapshot = await gitSnapshot(
    join(repo, ".git"),
    "HEAD",
    testRuntime(repo),
  );

  const [entry] = snapshot.entries;
  const absent = "0123456789abcdef0123456789abcdef01234567";

  await expect(snapshot.readBlobs([absent, entry!.hash])).rejects.toThrow(
    /is missing from/,
  );

  const blobs = await snapshot.readBlobs([entry!.hash]);
  expect(blobs.get(entry!.hash)?.toString()).toBe("first");
});
