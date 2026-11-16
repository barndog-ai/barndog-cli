/**
 * Turns a sync's plan (the links, native entries and installed folders it
 * wants) into journaled writes, and reports what each one changes. Nothing
 * here touches a destination: it reads what is there now and refuses when
 * something BarnDog doesn't own, or a hand edit, is in the way.
 */
import type { RuntimeContext } from "../../runtime.js";
import type { Link, State } from "../../config/state.js";
import type { Settings } from "../../config/settings.js";
import type { PackageKind } from "../../config/selection.js";
import { CliError } from "../../errors.js";
import { fileText } from "../../shared/files.js";
import { fixSteps, removeCommand } from "../../platform.js";
import { treeFingerprint } from "../workspace/tree.js";
import { assetKinds } from "../asset-kinds/index.js";
import { patchNative, type NativeEntry } from "../native/configuration.js";
import type { SyncEvent } from "./events.js";
import { linkTarget, type Write } from "./transaction.js";

/** An installed folder a sync wants, and the cached package it is filled from. */
export type InstalledTree = {
  id: string;
  kind: PackageKind;
  path: string;
  source: string;
  rename: string | null;
  fingerprint: string;
  versionId: string;
};

type InstalledState = State["installed"];

/** What a sync did to one installed link or native entry. */
type ChangeType = "installed" | "updated" | "unchanged";

function changeType(change: {
  /** The destination held this asset before. */
  sameAsset: boolean;
  /** The destination already matches what sync would write. */
  current: boolean;
  /** The asset's content changed in this sync. */
  contentChanged: boolean;
}): ChangeType {
  if (!change.sameAsset) {
    return "installed";
  }

  if (change.current && !change.contentChanged) {
    return "unchanged";
  }

  return "updated";
}

/** Stops a sync that would overwrite an installed folder someone edited by hand. */
export async function assertInstalledUntouched(
  installed: InstalledState,
  settings: Settings,
  runtime: RuntimeContext,
) {
  for (const entry of installed) {
    const actual = await treeFingerprint(entry.path, runtime);
    if (actual !== null && actual !== entry.fingerprint) {
      throw new CliError(
        `The installed copy at ${entry.path} was edited by hand. Syncing would overwrite those edits. ${
          settings.localWorkspace &&
          !settings.connection &&
          !settings.gitWorkspace
            ? "To keep them, copy that folder somewhere else first."
            : `To keep them, make an editable copy with barndog ${assetKinds[entry.kind].command} pull first.`
        }`,
        "Delete the installed copy; the next sync installs it again.",
        {
          command: fixSteps(
            [removeCommand(entry.path, runtime.platform), "barndog sync"],
            runtime.platform,
          ),
        },
      );
    }
  }
}

/**
 * One write per installed folder, old or new, and the paths of the folders
 * whose content changes (`updated`), which is what makes a link or Hook
 * registration count as updated.
 */
export async function treeWrites(
  installed: InstalledState,
  trees: readonly InstalledTree[],
  runtime: RuntimeContext,
): Promise<{ writes: Write[]; updated: Set<string> }> {
  const writes: Write[] = [];
  const updated = new Set<string>();

  for (const treePath of new Set([
    ...installed.map((entry) => entry.path),
    ...trees.map((tree) => tree.path),
  ])) {
    const next = trees.find((tree) => tree.path === treePath);
    const before = await treeFingerprint(treePath, runtime);
    const after = next?.fingerprint ?? null;

    if (before !== null && after !== null && before !== after) {
      updated.add(treePath);
    }

    writes.push({
      kind: "tree",
      path: treePath,
      before,
      after,
      source: next?.source ?? null,
      rename: next?.rename ?? null,
    });
  }

  return { writes, updated };
}

/**
 * One write per Skill link, old or new. Refuses a link changed outside BarnDog
 * and a destination holding a Skill BarnDog didn't install.
 */
export async function linkWrites(
  previous: readonly Link[],
  desired: readonly Link[],
  updated: ReadonlySet<string>,
): Promise<{ writes: Write[]; events: SyncEvent[] }> {
  for (const link of previous) {
    const actual = await linkTarget(link.target);
    if (actual !== null && actual !== link.source) {
      throw new CliError(
        `${link.target} was changed outside BarnDog. Restore or remove it, then sync again.`,
        "barndog sync",
      );
    }
  }

  for (const link of desired) {
    const actual = await linkTarget(link.target);
    const old = previous.find((l) => l.target === link.target);

    if (actual !== null && !old) {
      throw new CliError(
        `${link.target} is a Skill BarnDog didn't install, so it won't replace it. Move or rename it, then sync again.`,
        "barndog sync",
      );
    }
  }

  const writes: Write[] = [];
  const events: SyncEvent[] = [];
  for (const target of new Set([
    ...previous.map((l) => l.target),
    ...desired.map((l) => l.target),
  ])) {
    const old = previous.find((l) => l.target === target);
    const next = desired.find((l) => l.target === target);
    const actual = await linkTarget(target);

    if (old && (!next || next.id !== old.id)) {
      events.push({ type: "removed", link: old });
    }

    if (next) {
      events.push({
        type: changeType({
          sameAsset: old?.id === next.id,
          current: actual === next.source,
          contentChanged: updated.has(next.source),
        }),
        link: next,
      });
    }

    writes.push({
      kind: "link",
      path: target,
      before: actual,
      after: next?.source ?? null,
    });
  }

  return { writes, events };
}

/**
 * One write per native settings file that holds, or will hold, an entry of
 * BarnDog's. `nameOf` gives the name an entry is reported under.
 */
export async function nativeWrites(
  previous: readonly NativeEntry[],
  desired: readonly NativeEntry[],
  context: {
    trees: readonly InstalledTree[];
    updated: ReadonlySet<string>;
    nameOf: (entry: NativeEntry) => string;
  },
): Promise<{ writes: Write[]; events: SyncEvent[] }> {
  const { trees, updated, nameOf } = context;
  const writes: Write[] = [];
  const events: SyncEvent[] = [];

  for (const file of new Set([
    ...previous.map((e) => e.file),
    ...desired.map((e) => e.file),
  ])) {
    const old = previous.filter((e) => e.file === file);
    const next = desired.filter((e) => e.file === file);
    const text = await fileText(file);

    writes.push({
      kind: "file",
      path: file,
      before: text,
      after: patchNative(text, old, next),
    });

    for (const entry of next) {
      events.push({
        type: "native",
        action: changeType({
          sameAsset: old.some(
            (e) => e.id === entry.id && e.harness === entry.harness,
          ),
          current: old.some((e) => JSON.stringify(e) === JSON.stringify(entry)),
          contentChanged:
            entry.kind === "hook" &&
            trees.some((t) => t.id === entry.id && updated.has(t.path)),
        }),
        kind: entry.kind,
        harness: entry.harness,
        name: nameOf(entry),
      });
    }

    for (const entry of old) {
      if (
        !next.some(
          (e) =>
            JSON.stringify(e) === JSON.stringify(entry) ||
            (e.id === entry.id && e.harness === entry.harness),
        )
      ) {
        events.push({
          type: "native",
          action: "removed",
          kind: entry.kind,
          harness: entry.harness,
          name: nameOf(entry),
        });
      }
    }
  }

  return { writes, events };
}

/**
 * How a native entry is named in reports. Hook registrations carry IDs, so
 * `known` maps an asset ID to its name or installed folder; a later pair wins.
 */
export function entryNames(known: Iterable<readonly [string, string]>) {
  const names = new Map(known);

  return (entry: { kind: string; key: string; id: string }) => {
    if (entry.kind === "mcp") {
      return entry.key;
    }

    if (entry.kind === "knowledge") {
      return "knowledge index";
    }

    if (entry.kind === "sync") {
      return "workspace sync";
    }

    return names.get(entry.id) ?? entry.id;
  };
}

/** The text of `~/.barndog/state.json` once the plan is applied. */
export function stateText(plan: {
  links: readonly Link[];
  native: readonly NativeEntry[];
  trees: readonly InstalledTree[];
}): string {
  return (
    JSON.stringify(
      {
        version: 1,
        links: plan.links,
        native: plan.native,
        installed: plan.trees.map(
          ({ id, kind, path, fingerprint, versionId }) => ({
            id,
            kind,
            path,
            fingerprint,
            versionId,
          }),
        ),
      },
      null,
      2,
    ) + "\n"
  );
}
