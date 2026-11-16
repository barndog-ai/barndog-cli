import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  packageFingerprint,
  type PackageEntry,
} from "@barndog-ai/api-contract/package";

import { CliError } from "../../errors.js";
import { fileExecutable } from "../../platform.js";
import type { RuntimeContext } from "../../runtime.js";
import { ifExists } from "../../shared/files.js";

/**
 * Every file in an installed folder. Not `readDirectory()` from the contract
 * package: that one reads a package to submit, so it skips `.git` and stops at
 * package size limits. Here everything counts: a `.git` or large file added by
 * hand must show up as a hand edit and be removed by mirroring.
 */
export async function readTree(
  directory: string,
  runtime: RuntimeContext,
): Promise<PackageEntry[]> {
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
          executable: await fileExecutable(
            join(directory, path),
            info.mode,
            runtime,
          ),
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
export async function treeFingerprint(
  directory: string,
  runtime: RuntimeContext,
) {
  const info = await ifExists(lstat(directory));
  if (!info) {
    return null;
  }

  if (!info.isDirectory()) {
    return `not-a-directory:${info.mode}`;
  }

  try {
    return packageFingerprint(await readTree(directory, runtime));
  } catch {
    return "unreadable";
  }
}
