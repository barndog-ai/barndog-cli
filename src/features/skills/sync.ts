import {
  lstat,
  mkdir,
  readlink,
  realpath,
  symlink,
  unlink,
  rmdir,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { skillDirectory } from "../../harnesses/registry.js";
import { readState, saveState, type Link } from "../../config/state.js";
import { validateSelection, validateSkillSource } from "./validation.js";
import { isRecord } from "../../shared/values.js";
import {
  readSettings,
  settingsPath,
  SetupRequiredError,
  type Settings,
} from "../../config/settings.js";

import { prepareSources } from "./remote.js";

export type SyncEvent =
  | {
      type: "native";
      action: "installed" | "updated" | "removed" | "unchanged";
      kind: "mcp" | "hook" | "knowledge" | "sync";
      harness: import("../../harnesses/types.js").Harness;
      name: string;
    }
  | {
      type: "unsupported";
      kind: "mcp" | "hook";
      harness: import("../../harnesses/types.js").Harness;
      name: string;
      reason: string;
    }
  | { type: "disabled"; id: string }
  | { type: "notice"; message: string }
  | {
      type: "invalid";
      kind: "skill" | "mcp" | "hook";
      name: string;
      reason: string;
    }
  | {
      type: "clash";
      kind: "skill" | "mcp";
      name: string;
      installed: { name: string; origin: string };
      skipped: { name: string; origin: string; rename: string };
    }
  | { type: "installed" | "updated" | "removed" | "unchanged"; link: Link };

function missing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

async function pointsTo(link: Link): Promise<boolean> {
  const info = await stat(link.target);
  return (
    !!info?.isSymbolicLink() &&
    resolve(dirname(link.target), await readlink(link.target)) === link.source
  );
}

/** home is injectable for isolated filesystem tests; the CLI always uses the real user home. */
export async function sync(
  configPath?: string,
  home = homedir(),
  override?: Settings,
): Promise<SyncEvent[]> {
  home = resolve(home);
  configPath = resolve(configPath ?? settingsPath(home));
  const settings = override ?? (await readSettings(home, configPath));
  if (!settings) throw new SetupRequiredError();
  const desired: Link[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  const events: SyncEvent[] = [];
  for (const item of await prepareSources(settings, home)) {
    validateSelection(item);
    if (ids.has(item.id)) throw new Error(`Duplicate skill ID: ${item.id}`);
    ids.add(item.id);
    // Disabled selections remain valid even if their original source is temporarily unavailable.
    if (!item.enabled) {
      events.push({ type: "disabled", id: item.id });
      continue;
    }
    const source = await realpath(resolve(dirname(configPath), item.source));
    const metadata = await validateSkillSource(source);
    if (names.has(metadata.name))
      throw new Error(`Conflicting enabled skill name: ${metadata.name}`);
    names.add(metadata.name);
    for (const harness of settings.harnesses) {
      const target = resolve(skillDirectory(harness, home), metadata.name);
      if (inside(source, target) || inside(target, source))
        throw new Error(`Source overlaps installation: ${source}`);
      desired.push({ id: item.id, harness, source, target });
    }
  }

  const stateDir = dirname(settingsPath(home));
  await mkdir(stateDir, { recursive: true });
  const lock = resolve(stateDir, "sync.lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST")
      throw new Error(
        `Another sync is running. If it crashed, remove ${lock}`,
        {
          cause: error,
        },
      );
    throw error;
  }
  try {
    const statePath = resolve(stateDir, "state.json");
    const state = await readState(statePath, home);
    // Preflight all destinations before altering any installation.
    for (const old of state.links) {
      if ((await stat(old.target)) && !(await pointsTo(old)))
        throw new Error(`Managed link was changed externally: ${old.target}`);
    }
    for (const next of desired) {
      if (
        (await stat(next.target)) &&
        !state.links.some((old) => old.target === next.target)
      ) {
        throw new Error(
          `Existing unmanaged skill; refusing to overwrite: ${next.target}`,
        );
      }
    }
    for (const old of [...state.links]) {
      if (
        desired.some(
          (next) =>
            next.target === old.target &&
            next.source === old.source &&
            next.id === old.id,
        )
      )
        continue;
      if (await pointsTo(old)) await unlink(old.target);
      state.links = state.links.filter((link) => link.target !== old.target);
      await saveState(statePath, state);
      events.push({ type: "removed", link: old });
    }
    for (const next of desired) {
      if (await pointsTo(next)) {
        events.push({ type: "unchanged", link: next });
        continue;
      }
      await mkdir(dirname(next.target), { recursive: true });
      // Save ownership first so a crash after symlink creation can be recovered on the next sync.
      state.links = state.links.filter((link) => link.target !== next.target);
      state.links.push(next);
      await saveState(statePath, state);
      await symlink(next.source, next.target, "dir");
      events.push({ type: "installed", link: next });
    }
    return events;
  } finally {
    await rmdir(lock);
  }
}
