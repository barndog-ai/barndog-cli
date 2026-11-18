import {
  mkdtemp,
  mkdir,
  writeFile,
  access,
  rm,
  readFile,
  utimes,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi, type TestContext } from "vitest";
import { withPidLock } from "../shared/lock.js";
import { CliError } from "../errors.js";

const messages = { starting: "starting", running: "running" };

async function lockPath(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "barndog-lock-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));

  return { root, path: join(root, "lock") };
}

/** The PID of a process that has already exited. */
function deadPid() {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  if (!pid) {
    throw new Error("Couldn't start a child process");
  }

  return pid;
}

test("a lock whose owner hasn't written its PID yet is reported as starting", async (t) => {
  const { path } = await lockPath(t);
  await mkdir(path);
  const run = vi.fn();

  const error: unknown = await withPidLock(path, messages, run).catch(
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(CliError);
  expect(error).toHaveProperty("message", "starting");
  expect(run).not.toHaveBeenCalled();
});

test("a lock held by a live process is reported as running and kept", async (t) => {
  const { path } = await lockPath(t);
  await mkdir(path);
  await writeFile(join(path, "pid"), String(process.pid));
  const run = vi.fn();

  const error: unknown = await withPidLock(path, messages, run).catch(
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(CliError);
  expect(error).toHaveProperty("message", "running");
  expect(run).not.toHaveBeenCalled();
  expect(await readFile(join(path, "pid"), "utf8")).toBe(String(process.pid));
});

test("a lock held by another user's live process is reported as running, not as a permission error", async (t) => {
  const { path } = await lockPath(t);
  await mkdir(path);
  await writeFile(join(path, "pid"), "12345");
  // Signalling another user's process fails with EPERM: it exists, so it still holds the lock.
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  });

  const run = vi.fn();
  try {
    const error: unknown = await withPidLock(path, messages, run).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CliError);
    expect(error).toHaveProperty("message", "running");
  } finally {
    kill.mockRestore();
  }

  expect(run).not.toHaveBeenCalled();
  expect(await readFile(join(path, "pid"), "utf8")).toBe("12345");
});

test("a lock left by a process that died is taken over, held during the operation and released", async (t) => {
  const { path } = await lockPath(t);
  await mkdir(path);
  await writeFile(join(path, "pid"), String(deadPid()));

  const result = await withPidLock(path, messages, async () =>
    readFile(join(path, "pid"), "utf8"),
  );

  expect(result).toBe(String(process.pid));
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a failing operation still releases the lock and its error reaches the caller", async (t) => {
  const { path } = await lockPath(t);
  const failure = new Error("operation");

  await expect(
    withPidLock(path, messages, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);

  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a lock path under a file fails with the filesystem error, before the operation runs", async (t) => {
  const { root } = await lockPath(t);
  const file = join(root, "file");
  await writeFile(file, "content");
  const run = vi.fn();

  const error: unknown = await withPidLock(
    join(file, "lock"),
    messages,
    run,
  ).catch((caught: unknown) => caught);

  expect(error).not.toBeInstanceOf(CliError);
  expect(error).toHaveProperty(
    "code",
    expect.stringMatching(/^(EEXIST|ENOTDIR)$/),
  );

  expect(run).not.toHaveBeenCalled();
});

test("a lock that never got a PID is taken over once it is old enough to be left by a crash", async (t) => {
  const { path } = await lockPath(t);
  await mkdir(path);
  const minuteAgo = new Date(Date.now() - 60_000);
  await utimes(path, minuteAgo, minuteAgo);

  const result = await withPidLock(path, messages, async () =>
    readFile(join(path, "pid"), "utf8"),
  );

  expect(result).toBe(String(process.pid));
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("two callers that find the same dead lock never hold it at once", async (t) => {
  const { path } = await lockPath(t);
  await mkdir(path);
  await writeFile(join(path, "pid"), String(deadPid()));
  let holders = 0;
  let most = 0;
  const run = async () => {
    holders++;
    most = Math.max(most, holders);
    await new Promise((resolve) => setTimeout(resolve, 50));
    holders--;
  };

  const results = await Promise.allSettled([
    withPidLock(path, messages, run),
    withPidLock(path, messages, run),
  ]);

  expect(most).toBe(1);
  expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { message: "running" },
  });
});
