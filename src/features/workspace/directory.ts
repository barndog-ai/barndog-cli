/**
 * Package folders on disk: reading one to submit, writing one BarnDog
 * fetched. Package paths always use `/`; local paths only appear at the
 * filesystem calls.
 */
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { readDirectory as readPackageDirectory } from "@barndog-ai/api-contract/collaboration";
import {
  writePackage as writePackageFiles,
  packageFingerprint,
  type PackageEntry,
} from "@barndog-ai/api-contract/package";

import {
  assertPackagePaths,
  fileExecutable,
  isWindows,
} from "../../platform.js";
import type { RuntimeContext } from "../../runtime.js";
import { readTree } from "./tree.js";

/**
 * A package folder's files. Windows keeps no executable bit, so there a
 * file's flag comes from the same path in `known`, the files BarnDog last wrote
 * here (see `fileExecutable()`).
 */
export async function readDirectory(
  directory: string,
  runtime: RuntimeContext,
  known: readonly PackageEntry[] = [],
): Promise<PackageEntry[]> {
  const entries = await readPackageDirectory(directory);
  if (!isWindows(runtime.platform)) {
    return entries;
  }

  const flags = new Map(known.map((entry) => [entry.path, entry.executable]));

  return Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.path);

      return {
        ...entry,
        executable: await fileExecutable(
          path,
          (await lstat(path)).mode,
          runtime,
          flags.get(entry.path),
        ),
      };
    }),
  );
}

export async function writePackage(
  directory: string,
  entries: PackageEntry[],
  runtime: RuntimeContext,
) {
  assertPackagePaths(entries, runtime.platform);
  await writePackageFiles(directory, entries);
}

/** What `readTree()` sees in the folder, so compare it only with another one. */
export async function directoryFingerprint(
  directory: string,
  runtime: RuntimeContext,
) {
  return packageFingerprint(await readTree(directory, runtime));
}
