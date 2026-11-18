import { POSIX_MODE } from "./constants.js";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { errorCode } from "./values.js";
import { CliError } from "./cli-error.js";
import { ifExists, writeAtomic } from "./files.js";

/** What to tell a process that finds the lock taken. */
export type LockMessages = {
  /** Another process created the lock but hasn't written its PID yet. */
  starting: string;
  /** Another live process holds the lock. */
  running: string;
};

/**
 * How long a lock may exist without a PID before it counts as left by a
 * process that crashed between creating it and writing its PID. Writing the
 * PID takes milliseconds.
 */
const STARTING_GRACE_MS = 10_000;

/** How long to wait while another process clears the same stale lock. */
const TAKEOVER_RETRY_MS = 50;

/** Attempts before giving up on a lock that keeps changing hands. */
const MAX_ATTEMPTS = 100;

/** Who holds the lock folder at `path`, judged from its PID file and age. */
type Owner = "free" | "starting" | "running" | "stale";

async function ownerOf(path: string): Promise<Owner> {
  const info = await ifExists(stat(path));
  if (!info) {
    return "free";
  }

  const text = await ifExists(readFile(join(path, "pid"), "utf8"));
  const pid = Number(text ?? 0);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return Date.now() - info.mtimeMs > STARTING_GRACE_MS ? "stale" : "starting";
  }

  try {
    process.kill(pid, 0);

    return "running";
  } catch (failure) {
    // EPERM: the owner is alive but belongs to another user, so it still holds the lock.
    return errorCode(failure) === "ESRCH" ? "stale" : "running";
  }
}

/**
 * Removes the lock at `path` if it is still stale. A short-lived guard folder
 * makes the check and the removal one step, so a process that saw the same
 * stale lock can't remove a fresh lock another process just took.
 */
async function removeStale(path: string): Promise<void> {
  const guard = `${path}.takeover`;
  try {
    await mkdir(guard);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }

    const info = await ifExists(stat(guard));
    if (info && Date.now() - info.mtimeMs > STARTING_GRACE_MS) {
      await rm(guard, { recursive: true, force: true });
    } else {
      await sleep(TAKEOVER_RETRY_MS);
    }

    return;
  }

  try {
    if ((await ownerOf(path)) === "stale") {
      await rm(path, { recursive: true, force: true });
    }
  } finally {
    await rm(guard, { recursive: true, force: true });
  }
}

/** Creates the lock folder, taking over a stale one; throws when it is held. */
async function acquire(path: string, messages: LockMessages): Promise<void> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await mkdir(path, { mode: POSIX_MODE.privateDirectory });

      return;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }

      const owner = await ownerOf(path);
      if (owner === "starting") {
        throw new CliError(messages.starting, undefined, { cause: error });
      }

      if (owner === "running") {
        throw new CliError(messages.running, undefined, { cause: error });
      }

      if (owner === "stale") {
        await removeStale(path);
      }
    }
  }

  throw new CliError(messages.running);
}

/**
 * Runs `run` while holding a lock across processes: a folder at `path` holding
 * the owner's PID. A lock whose process has died, or that never got a PID, is
 * taken over; liveness comes from the PID, not from the lock's age, so a long
 * operation never loses it.
 */
export async function withPidLock<T>(
  path: string,
  messages: LockMessages,
  run: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(path), {
    recursive: true,
    mode: POSIX_MODE.privateDirectory,
  });

  await acquire(path, messages);

  try {
    await writeAtomic(join(path, "pid"), String(process.pid));

    return await run();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
