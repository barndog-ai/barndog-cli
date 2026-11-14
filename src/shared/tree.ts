import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  packageFingerprint,
  type PackageEntry,
} from "@barndog-ai/api-contract/package";

import { CliError } from "./cli-error.js";
import { POSIX_MODE } from "./constants.js";
import { errorCode } from "./values.js";

/**
 * Every file in an installed folder. Not `readDirectory()` from the contract
 * package: that one reads a package to submit, so it skips `.git` and stops at
 * package size limits. Here everything counts: a `.git` or large file added by
 * hand must show up as a hand edit and be removed by mirroring.
 */
export async function readTree(directory: string): Promise<PackageEntry[]> {
  const entries: PackageEntry[] = [];

  async function visit(base: string) {
    for (const child of (await readdir(join(directory, base))).sort()) {
      const path = base ? `${base}/${child}` : child;
      const info = await lstat(join(directory, path));
      if (info.isDirectory()) {
        await visit(path);
      } else if (info.isFile()) {
        entries.push({
          path,
          data: await readFile(join(directory, path)),
          executable: !!(info.mode & POSIX_MODE.executableBits),
        });
      } else {
        throw new CliError(
          `${join(directory, path)} isn't a regular file or folder, so BarnDog can't read it.`,
        );
      }
    }
  }

  await visit("");

  return entries;
}

/** Fingerprint of an installed folder, or null when it does not exist. */
export async function treeFingerprint(directory: string) {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory()) {
      return `not-a-directory:${info.mode}`;
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }

    throw error;
  }

  try {
    return packageFingerprint(await readTree(directory));
  } catch {
    return "unreadable";
  }
}
