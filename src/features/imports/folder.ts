import { localPath } from "../../platform.js";
import type { RuntimeContext } from "../../runtime.js";
import { existsSync } from "node:fs";
import { rm, rmdir, stat } from "node:fs/promises";
import { dirname, join, parse } from "node:path";

import { CliError } from "../../errors.js";
import { folderSnapshot, isBlob } from "../workspace/snapshot.js";
import type { RemoteRepo } from "./remote.js";

/**
 * `~`, `~/…` or `~\…` at the start of a path, which a POSIX shell would
 * expand to the home folder; Windows shells pass it to BarnDog unexpanded.
 */
const HOME_PREFIX = /^~(?=[\\/]|$)/;

/**
 * `~/skills` → `/Users/me/skills`; other paths are unchanged.
 *
 * @internal Exported for its table test in `src/tests/patterns.test.ts`.
 */
export const expandHome = (path: string, runtime: RuntimeContext) => {
  const { home } = runtime;

  return path.replace(HOME_PREFIX, () => home);
};

/**
 * Text that can only mean a folder on this machine, never a repository URL:
 * `/abs`, `.`, `..`, `./x`, `../x`, `~` or `~/x`, and on Windows also `\x`,
 * `C:\x` or `C:/x`, `.\x`, `..\x` and `~\x`.
 */
const LOCAL_PATH = /^(?:[\\/]|[a-z]:|\.{1,2}(?:[\\/]|$)|~(?:[\\/]|$))/i;

/**
 * Recognizes path-like import inputs after trimming whitespace; does not check
 * filesystem existence.
 *
 * @internal Exported for its table test in `src/tests/patterns.test.ts`.
 */
export const looksLocal = (source: string) => LOCAL_PATH.test(source.trim());

/** The plain folder a source points at; Git repos return null and are fetched instead. */
export async function plainFolder(
  source: string,
  runtime: RuntimeContext,
): Promise<string | null> {
  const value = source.trim();
  const path = localPath(expandHome(value, runtime), runtime);
  const directory = await stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );

  if (!directory) {
    return null;
  }

  const isRepo =
    existsSync(join(path, ".git")) ||
    (existsSync(join(path, "HEAD")) && existsSync(join(path, "objects")));

  return isRepo ? null : path;
}

/** Git can't help with a path that isn't there, so say so instead of suggesting a clone. */
export function assertSourceExists(source: string, runtime: RuntimeContext) {
  const value = source.trim();
  if (!looksLocal(value)) {
    return;
  }

  if (!existsSync(localPath(expandHome(value, runtime), runtime))) {
    throw new CliError(`Can't find ${value}.`);
  }
}

/** Presents a folder the way a fetched repo looks, so discovery treats both alike. */
export async function readFolder(
  path: string,
  runtime: RuntimeContext,
): Promise<RemoteRepo> {
  const { home } = runtime;

  if (path === home || path === parse(path).root) {
    throw new CliError(
      `${path} is too broad to search. Point at the folder holding the Skill.`,
    );
  }

  const snapshot = await folderSnapshot(path, runtime);
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
    for (let dir = dirname(file); dir !== root; dir = dirname(dir)) {
      folders.add(dir);
    }
  }

  const deepestFirst = [...folders].sort((a, b) => b.length - a.length);
  for (const folder of deepestFirst) {
    await rmdir(folder).catch(() => {});
  }

  return !existsSync(root);
}
