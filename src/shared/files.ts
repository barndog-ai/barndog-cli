import { POSIX_MODE } from "./constants.js";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, isAbsolute, sep, type posix } from "node:path";
import type { z } from "zod";

import { errorCode } from "./values.js";
import { CliError } from "./cli-error.js";

export type AtomicWriteOptions = {
  /** The file's permissions; private to the user by default. */
  mode?: number;
  /** Permissions for parent folders this creates. */
  directoryMode?: number;
};

/**
 * Writes a temporary file beside `path` and renames it over `path`, so a reader
 * sees the old file or the new one, never half of one. Creates missing parent
 * folders.
 */
export async function writeAtomic(
  path: string,
  data: string | Uint8Array,
  {
    mode = 0o600,
    directoryMode = POSIX_MODE.privateDirectory,
  }: AtomicWriteOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: directoryMode });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * What `operation` returns, or null when the file or folder it touches doesn't
 * exist (`ENOENT`). Any other failure is thrown.
 */
export async function ifExists<T>(operation: Promise<T>): Promise<T | null> {
  try {
    return await operation;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }

    throw error;
  }
}

/** Why a file named on the command line can't be read, by Node error code. */
const inputProblems: Partial<Record<string, string>> = {
  ENOENT: "doesn't exist",
  EISDIR: "is a folder, not a file",
  EACCES: "can't be read: permission denied",
  EPERM: "can't be read: permission denied",
};

/**
 * A file the person running the CLI named, such as `--file` or `--input`. A
 * missing or unreadable one is a mistake they can fix, so it says which file.
 */
export async function inputFile(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    const problem = inputProblems[errorCode(error) ?? ""];
    if (problem) {
      throw new CliError(`${path} ${problem}.`, undefined, { cause: error });
    }

    throw error;
  }
}

/** `inputFile()` parsed as JSON; invalid JSON says which file. */
export async function inputJson(path: string): Promise<unknown> {
  const text = (await inputFile(path)).toString("utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(`${path} isn't valid JSON.`, undefined, {
      cause: error,
    });
  }
}

/** A file's text, or null when it doesn't exist. */
export function readIfExists(path: string): Promise<string | null> {
  return ifExists(readFile(path, "utf8"));
}

/** A JSON file checked against `schema`, or null when it doesn't exist. */
export async function readJsonIfExists<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const text = await readIfExists(path);

  return text === null ? null : schema.parse(JSON.parse(text));
}

/**
 * A regular file's text, or null when it doesn't exist. Refuses symlinks and
 * anything else that isn't a plain file, so a write can't be redirected.
 */
export async function fileText(path: string): Promise<string | null> {
  const info = await ifExists(lstat(path));
  if (!info) {
    return null;
  }

  if (!info.isFile() || info.isSymbolicLink()) {
    throw new CliError(
      `${path} is a link or not a regular file, so BarnDog won't edit it.`,
    );
  }

  return readIfExists(path);
}

/** Whether `child` is `parent` or somewhere below it; compares paths, not links. */
export function isInside(
  parent: string,
  child: string,
  paths: Pick<typeof posix, "relative" | "isAbsolute" | "sep"> = {
    relative,
    isAbsolute,
    sep,
  },
): boolean {
  const path = paths.relative(parent, child);

  return (
    !path ||
    (path !== ".." &&
      !path.startsWith(`..${paths.sep}`) &&
      !paths.isAbsolute(path))
  );
}
