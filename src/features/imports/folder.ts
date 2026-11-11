import { existsSync } from "node:fs";
import { rm, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

import { CliError } from "../../errors.js";
import { folderSnapshot, isBlob } from "../git-workspace/snapshot.js";
import type { RemoteRepo } from "./remote.js";

/** The plain folder a source points at; Git repos return null and are fetched instead. */
export async function plainFolder(source: string): Promise<string | null> {
  const value = source.trim();
  const path = resolve(value.replace(/^~(?=\/|$)/, homedir()));
  const directory = await stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!directory) return null;
  const isRepo =
    existsSync(join(path, ".git")) ||
    (existsSync(join(path, "HEAD")) && existsSync(join(path, "objects")));
  return isRepo ? null : path;
}

/** Git can't help with a path that isn't there, so say so instead of suggesting a clone. */
export function assertSourceExists(source: string) {
  const value = source.trim();
  if (!/^(\/|\.{1,2}(\/|$)|~(\/|$))/.test(value)) return;
  if (!existsSync(resolve(value.replace(/^~(?=\/|$)/, homedir()))))
    throw new CliError(`Can't find ${value}.`);
}

/** Presents a folder the way a fetched repo looks, so discovery treats both alike. */
export async function readFolder(path: string): Promise<RemoteRepo> {
  if (path === homedir() || path === parse(path).root)
    throw new CliError(
      `${path} is too broad to search. Point at the folder holding the Skill.`,
    );
  const snapshot = await folderSnapshot(path);
  const blobs = await snapshot.readBlobs(
    snapshot.entries
      .filter((entry) => isBlob(entry.mode))
      .map((entry) => entry.hash),
  );
  return { url: path, ref: null, commit: "", path: "", snapshot, blobs };
}

/**
 * Deletes only the files that were imported, so anything else in the folder survives.
 * Returns whether the folder itself is gone.
 */
export async function removeImported(
  root: string,
  entries: readonly { path: string }[],
) {
  const folders = new Set<string>([root]);
  for (const entry of entries) {
    const file = join(root, entry.path);
    await rm(file, { force: true });
    for (let dir = dirname(file); dir !== root; dir = dirname(dir))
      folders.add(dir);
  }
  const deepestFirst = [...folders].sort((a, b) => b.length - a.length);
  for (const folder of deepestFirst) await rmdir(folder).catch(() => {});
  return !existsSync(root);
}
