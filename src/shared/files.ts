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
import { dirname, isAbsolute, relative, sep } from "node:path";
import { errorCode } from "./values.js";

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
 * A regular file's text, or null when it doesn't exist. Refuses symlinks and
 * anything else that isn't a plain file, so a write can't be redirected.
 */
export async function fileText(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Refusing non-regular configuration file: ${path}`);
    }

    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }

    throw error;
  }
}

/** Whether `child` is `parent` or somewhere below it; compares paths, not links. */
export function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);

  return (
    !path ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}
