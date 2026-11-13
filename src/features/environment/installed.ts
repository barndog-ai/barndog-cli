import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  packageFingerprint,
  type PackageEntry,
} from "@barndog-ai/api-contract/package";
import { assetKinds, type PackageKind } from "../asset-kinds/index.js";
import { errorCode } from "../../errors.js";
import { setYamlName, splitFrontMatter } from "../../shared/patterns.js";

/** Readable, stable folders that harnesses resolve; the commit-pinned cache stays internal. */
export function installedRoot(home: string, kind: PackageKind) {
  return join(home, ".barndog", "installed", assetKinds[kind].folder);
}

export function installedPath(home: string, kind: PackageKind, name: string) {
  return join(installedRoot(home, kind), name);
}

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
          executable: !!(info.mode & 0o111),
        });
      } else {
        throw new Error(`Unexpected file type in ${join(directory, path)}`);
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
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const wanted = new Map(entries.map((entry) => [entry.path, entry]));
  let current: PackageEntry[] = [];
  try {
    current = await readTree(directory);
  } catch {
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true, mode: 0o755 });
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
    const mode = entry.executable ? 0o755 : 0o644;
    if (existing?.data.equals(entry.data)) {
      if (existing.executable !== entry.executable) {
        await chmod(path, mode);
      }

      continue;
    }

    await mkdir(dirname(path), { recursive: true, mode: 0o755 });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, entry.data, { mode, flag: "wx" });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  }
}
