import { POSIX_MODE } from "./constants.js";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorCode } from "./values.js";
import { CliError } from "./cli-error.js";
import { writeAtomic } from "./files.js";

/** What to tell a process that finds the lock taken. */
export type LockMessages = {
  /** Another process created the lock but hasn't written its PID yet. */
  starting: string;
  /** Another live process holds the lock. */
  running: string;
};

/**
 * Runs `run` while holding a lock across processes: a folder at `path` holding
 * the owner's PID. A lock whose process has died is taken over; liveness comes
 * from the PID, not from the lock's age, so a long operation never loses it.
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

  try {
    await mkdir(path);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }

    const pid = Number(
      await readFile(join(path, "pid"), "utf8").catch(() => "0"),
    );

    if (!pid) {
      throw new CliError(messages.starting, undefined, { cause: error });
    }

    try {
      process.kill(pid, 0);
    } catch (failure) {
      if (errorCode(failure) !== "ESRCH") {
        throw failure;
      }

      await rm(path, { recursive: true });

      return withPidLock(path, messages, run);
    }

    throw new CliError(messages.running, undefined, { cause: error });
  }

  try {
    await writeAtomic(join(path, "pid"), String(process.pid));

    return await run();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
