/**
 * Leaves BarnDog's Skills and Hooks in each coding tool as plain files of the
 * tool's own, so they keep working once `~/.barndog/` is gone: each Skill link
 * becomes a copy of the folder it pointed at, and each Hook folder is copied
 * beside the tool's hook settings, where its registrations are pointed next.
 * MCP entries need nothing: they never point into BarnDog's files.
 *
 * Every step checks what is already done, so an interrupted uninstall can run
 * again.
 */
import { cp, lstat, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { State } from "../../config/state.js";
import { CliError } from "../../errors.js";
import { isHookHarness, nativeFile } from "../../harnesses/registry.js";
import type { Harness } from "../../harnesses/types.js";
import type { RuntimeContext } from "../../runtime.js";
import { ifExists } from "../../shared/files.js";
import { isRecord } from "../../shared/values.js";
import type { NativeEntry } from "../native/configuration.js";
import { movedHookCommand } from "../native/hook-shell.js";
import { linkTarget } from "../environment/transaction.js";
import { treeFingerprint } from "../workspace/tree.js";

/** A Skill or Hook folder left in a coding tool. */
export type LeftAsset = {
  kind: "skill" | "hook";
  name: string;
  harness: Harness;
  path: string;
};

/** One folder to put at `path`, copied from BarnDog's installed `source`. */
type Placement = LeftAsset & { source: string };

/** Where a Hook's folder goes: `hooks/<name>` beside the tool's hook settings. */
const hookFolder = (harness: Harness, name: string, home: string) =>
  join(dirname(nativeFile(harness, "hook", home)), "hooks", name);

function placements(state: State, home: string): Placement[] {
  const skills: Placement[] = state.links.map((link) => ({
    kind: "skill",
    name: basename(link.target),
    harness: link.harness,
    path: link.target,
    source: link.source,
  }));

  const hooks: Placement[] = [];
  for (const entry of state.native) {
    const folder = state.installed.find(
      (installed) => installed.kind === "hook" && installed.id === entry.id,
    );

    if (
      entry.kind !== "hook" ||
      !folder ||
      hooks.some(
        (hook) => hook.source === folder.path && hook.harness === entry.harness,
      )
    ) {
      continue;
    }

    const name = basename(folder.path);
    hooks.push({
      kind: "hook",
      name,
      harness: entry.harness,
      path: hookFolder(entry.harness, name, home),
      source: folder.path,
    });
  }

  return [...skills, ...hooks];
}

/**
 * Whether the folder is already in place: true when `path` holds the same
 * files as `source`. Throws when something else is there.
 */
async function placed(placement: Placement, runtime: RuntimeContext) {
  const { path, source } = placement;

  const info = await ifExists(lstat(path));
  if (!info) {
    return false;
  }

  if (info.isSymbolicLink() && placement.kind === "skill") {
    if ((await linkTarget(path)) !== source) {
      throw new CliError(
        `${path} was changed outside BarnDog, so uninstall stopped before changing anything.`,
        "Restore or remove that link, then run barndog uninstall again",
      );
    }

    return false;
  }

  const [here, there] = await Promise.all([
    treeFingerprint(path, runtime),
    treeFingerprint(source, runtime),
  ]);

  if (here === null || here !== there) {
    throw new CliError(
      `${path} already exists, so BarnDog can't leave its ${placement.name} ${placement.kind === "skill" ? "Skill" : "Hook"} there.`,
      "Move it aside, then run barndog uninstall again",
    );
  }

  return true;
}

/** Copies beside the destination first, so a Skill is never missing for long. */
async function place(placement: Placement) {
  const { path, source } = placement;
  const staging = `${path}.barndog-uninstall`;

  await rm(staging, { recursive: true, force: true });
  await cp(source, staging, { recursive: true });

  if (await ifExists(lstat(path))) {
    await unlink(path);
  }

  await rename(staging, path);
}

/** The Hook registration with its root variables pointing at `to`. */
function movedHook(
  entry: NativeEntry,
  folders: { from: string; to: string },
  platform: NodeJS.Platform,
): NativeEntry {
  const { harness } = entry;
  if (!isHookHarness(harness)) {
    throw new Error(`${harness} has no hook settings to move a Hook in`);
  }

  return {
    ...entry,
    value: mapCommands(entry.value, (command) => {
      const moved = movedHookCommand(command, folders, harness, platform);

      if (moved === undefined) {
        throw new Error(
          `A ${entry.key} Hook registration doesn't start the way BarnDog writes it`,
        );
      }

      return moved;
    }),
  };
}

/** Rewrites the handler's `command`, or each of its nested `hooks[].command`. */
function mapCommands(
  value: Record<string, unknown>,
  change: (command: string) => string,
): Record<string, unknown> {
  const next = { ...value };
  if (typeof next.command === "string") {
    next.command = change(next.command);
  }

  if (Array.isArray(next.hooks)) {
    next.hooks = next.hooks.map((hook: unknown) =>
      isRecord(hook) && typeof hook.command === "string"
        ? { ...hook, command: change(hook.command) }
        : hook,
    );
  }

  return next;
}

/**
 * Puts every Skill and Hook folder in place and returns the Hook registrations
 * pointed at their new folders, for the caller to write with the rest.
 */
export async function leaveInPlace(
  state: State,
  runtime: RuntimeContext,
): Promise<{ left: LeftAsset[]; hooks: NativeEntry[] }> {
  const planned = placements(state, runtime.home);

  // Check every destination before changing any.
  const done = new Set<Placement>();
  for (const placement of planned) {
    if (await placed(placement, runtime)) {
      done.add(placement);
    }
  }

  for (const placement of planned) {
    if (!done.has(placement)) {
      await place(placement);
    }
  }

  const hooks = state.native.flatMap((entry) => {
    const folder = planned.find(
      (placement) =>
        placement.kind === "hook" &&
        placement.harness === entry.harness &&
        state.installed.some(
          (installed) =>
            installed.id === entry.id && installed.path === placement.source,
        ),
    );

    return entry.kind === "hook" && folder
      ? [
          movedHook(
            entry,
            { from: folder.source, to: folder.path },
            runtime.platform,
          ),
        ]
      : [];
  });

  return {
    left: planned.map(({ kind, name, harness, path }) => ({
      kind,
      name,
      harness,
      path,
    })),
    hooks,
  };
}
