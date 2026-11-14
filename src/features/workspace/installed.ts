import { POSIX_MODE } from "../../shared/constants.js";

import { chmod, lstat, mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { type PackageEntry } from "@barndog-ai/api-contract/package";
import { type PackageKind } from "../../config/selection.js";
import { readTree } from "../../shared/tree.js";
import { setYamlName, splitFrontMatter } from "../../shared/patterns.js";
import { writeAtomic } from "../../shared/files.js";
import { barndogPaths } from "../../config/paths.js";

export function installedPath(home: string, kind: PackageKind, name: string) {
  return join(barndogPaths(home).installed(kind), name);
}

/** Points SKILL.md's name at the installed folder name; harnesses require them to match. */
export function renameSkillEntries(
  entries: PackageEntry[],
  name: string,
): PackageEntry[] {
  return entries.map((entry) => {
    if (entry.path !== "SKILL.md") {
      return entry;
    }

    const parts = splitFrontMatter(entry.data.toString("utf8"));
    if (!parts) {
      return entry;
    }

    const { open, yaml, close, body } = parts;

    return {
      ...entry,
      data: Buffer.from(`${open}${setYamlName(yaml, name)}${close}${body}`),
    };
  });
}

/**
 * Reads package files from a source folder and optionally rewrites Skill
 * metadata for an installed alias.
 */
export async function desiredEntries(
  source: string,
  rename: string | null,
): Promise<PackageEntry[]> {
  const entries = await readTree(source);

  return rename ? renameSkillEntries(entries, rename) : entries;
}

async function removeEmptyDirectories(directory: string) {
  for (const child of await readdir(directory)) {
    const path = join(directory, child);
    if ((await lstat(path)).isDirectory()) {
      await removeEmptyDirectories(path);
      if (!(await readdir(path)).length) {
        await rmdir(path);
      }
    }
  }
}

/**
 * Mirrors entries into an existing folder file by file. The folder itself is never
 * replaced, so harness file watchers observe edits instead of a vanished directory.
 */
export async function mirrorTree(directory: string, entries: PackageEntry[]) {
  await mkdir(directory, { recursive: true, mode: POSIX_MODE.executableFile });
  const wanted = new Map(entries.map((entry) => [entry.path, entry]));
  let current: PackageEntry[] = [];
  try {
    current = await readTree(directory);
  } catch {
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, {
      recursive: true,
      mode: POSIX_MODE.executableFile,
    });
  }

  for (const existing of current) {
    if (!wanted.has(existing.path)) {
      await rm(join(directory, existing.path), { force: true });
    }
  }

  // Emptied folders must go first: a new file may take one's exact path.
  await removeEmptyDirectories(directory);
  for (const entry of entries) {
    const path = join(directory, entry.path);
    const existing = current.find((item) => item.path === entry.path);
    const mode = entry.executable
      ? POSIX_MODE.executableFile
      : POSIX_MODE.regularFile;

    if (existing?.data.equals(entry.data)) {
      if (existing.executable !== entry.executable) {
        await chmod(path, mode);
      }

      continue;
    }

    await writeAtomic(path, entry.data, {
      mode,
      directoryMode: POSIX_MODE.executableFile,
    });
  }
}
