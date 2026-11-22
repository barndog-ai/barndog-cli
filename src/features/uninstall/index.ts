/**
 * `barndog uninstall`: takes BarnDog off this machine. BarnDog's own
 * registrations (the session-start sync, the knowledge index, OpenCode's
 * plugin module) always go. The developer's Skills, MCP servers and Hooks
 * either stay in each coding tool as plain files of its own, or go too, with
 * adopted assets put back where they came from. Then every session is signed
 * out and `~/.barndog/` is deleted, except the local workspace when kept.
 */
import { readdir, rm } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

import { barndogPaths } from "../../config/paths.js";
import { readSettings } from "../../config/settings.js";
import { readState } from "../../config/state.js";
import type { RuntimeContext } from "../../runtime.js";
import { fileText, ifExists, isInside } from "../../shared/files.js";
import { readAdoptions, type AdoptedAsset } from "../adoption/record.js";
import { undoAdoption } from "../adoption/undo.js";
import { signOutEverywhere, type SignedOut } from "../auth/session.js";
import type { SyncEvent } from "../environment/events.js";
import { locked, transact, type Write } from "../environment/transaction.js";
import {
  entryNames,
  linkWrites,
  nativeWrites,
  stateText,
} from "../environment/writes.js";
import { leaveInPlace, type LeftAsset } from "./leave.js";
import { mcpVariables, type McpVariable } from "./survey.js";

export type UninstallOptions = {
  /** Leave Skills, MCP servers and Hooks in the coding tools; otherwise remove them. */
  keepSetup: boolean;
  /** Adopted assets (`tool/kind/name`) to put back where they came from, when removing. */
  restore: readonly string[];
  /** Keep the local workspace folder when it is inside `~/.barndog/`. */
  keepWorkspace: boolean;
  /** Put adopted assets back even if BarnDog's copy was edited, losing the edits. */
  force?: boolean;
};

export type UninstallResult = {
  /** Whether Skills, MCP servers and Hooks were left in the coding tools. */
  keptSetup: boolean;
  /** Skills and Hooks left in the coding tools as plain folders. */
  left: LeftAsset[];
  /** What the MCP servers left in the tools read from the environment. */
  variables: McpVariable[];
  /** Entries taken out of the coding tools' settings, and removed Skill links. */
  removed: SyncEvent[];
  /** Adopted assets put back where they came from. */
  restored: AdoptedAsset[];
  signedOut: SignedOut[];
  /** `~/.barndog/`, now deleted, or holding only the kept workspace. */
  root: string;
  /** The local workspace folder, when it was kept inside `~/.barndog/`. */
  keptWorkspace?: string;
};

/** Undoes each adoption holding a chosen asset: whole when unfinished or fully chosen. */
async function restoreAdopted(
  options: UninstallOptions,
  runtime: RuntimeContext,
): Promise<AdoptedAsset[]> {
  if (options.keepSetup || !options.restore.length) {
    return [];
  }

  const restored: AdoptedAsset[] = [];
  for (const record of await readAdoptions(runtime.home)) {
    const open = record.items.filter((item) => !item.undone);
    const chosen = open.filter((item) => options.restore.includes(item.key));
    if (record.status === "undone" || !chosen.length) {
      continue;
    }

    const whole = record.status === "pending" || chosen.length === open.length;
    const result = await undoAdoption(
      {
        id: record.id,
        only: whole ? undefined : chosen.map((item) => item.key),
        force: options.force,
      },
      runtime,
    );

    restored.push(...result.restored);
  }

  return restored;
}

/**
 * Takes BarnDog's entries out of the coding tools' settings (all of them, or
 * only its own registrations when the setup stays, with Hooks pointed at
 * their new folders), removes Skill links, and empties `state.json`, as one
 * journaled change.
 */
async function removeEntries(
  keepSetup: boolean,
  runtime: RuntimeContext,
): Promise<Pick<UninstallResult, "left" | "removed" | "variables">> {
  const { home } = runtime;
  const stateFile = barndogPaths(home).state;
  const state = await readState(home);

  const kept = keepSetup
    ? await leaveInPlace(state, runtime)
    : { left: [], hooks: [] };

  // MCP entries that stay aren't BarnDog's to edit any more, so they are left out.
  const previous = keepSetup
    ? state.native.filter((entry) => entry.kind !== "mcp")
    : state.native;

  const nameOf = entryNames(
    state.installed.map((entry) => [entry.id, basename(entry.path)] as const),
  );

  const settings = await nativeWrites(previous, kept.hooks, {
    trees: [],
    updated: new Set(),
    nameOf,
    platform: runtime.platform,
  });

  // A Skill left in place is a folder now, so only links still to remove are written.
  const links = keepSetup
    ? { writes: [], events: [] }
    : await linkWrites(state.links, [], new Set());

  const writes: Write[] = [
    ...links.writes,
    ...settings.writes,
    {
      kind: "file",
      path: stateFile,
      before: await fileText(stateFile),
      after: stateText({ links: [], native: [], trees: [] }),
    },
  ];

  await transact(runtime, writes);

  const removed = [...links.events, ...settings.events].filter(
    (event) =>
      event.type === "removed" ||
      (event.type === "native" && event.action === "removed"),
  );

  return {
    left: kept.left,
    removed,
    variables: keepSetup ? mcpVariables(state) : [],
  };
}

/** Deletes `root`, or everything in it except the top folder holding `keep`. */
async function deleteRoot(root: string, keep: string | undefined) {
  if (!keep) {
    await rm(root, { recursive: true, force: true });

    return;
  }

  const [top] = relative(root, keep).split(sep);
  for (const name of (await ifExists(readdir(root))) ?? []) {
    if (name !== top) {
      await rm(join(root, name), { recursive: true, force: true });
    }
  }
}

export async function uninstall(
  options: UninstallOptions,
  runtime: RuntimeContext,
): Promise<UninstallResult> {
  const root = barndogPaths(runtime.home).root;
  // Read before anything changes; a damaged config.yaml only means no workspace to keep.
  const settings = await readSettings(runtime.home).catch(() => null);
  const workspace = settings?.localWorkspace?.path;

  const restored = await restoreAdopted(options, runtime);
  const { left, removed, variables } = await locked(runtime, () =>
    removeEntries(options.keepSetup, runtime),
  );

  const signedOut = await signOutEverywhere(runtime);

  const keptWorkspace =
    options.keepWorkspace && workspace && isInside(root, workspace)
      ? workspace
      : undefined;

  await deleteRoot(root, keptWorkspace);

  return {
    keptSetup: options.keepSetup,
    left,
    removed,
    variables,
    restored,
    signedOut,
    root,
    keptWorkspace,
  };
}
