/**
 * Decides, before anything is staged, which name each enabled Skill and MCP
 * server installs under: which invalid assets keep the name they hold, which
 * clashes are renamed, and which newcomers are skipped for this run.
 */
import { basename } from "node:path";

import type { Link, State } from "../../config/state.js";
import { treeFingerprint } from "../../shared/tree.js";
import type { SelectionResult } from "../asset-selection/types.js";
import { originLabel } from "../server/origin.js";
import type { SyncEvent } from "./events.js";
import { resolveClashes, type ClashResolver } from "./names.js";

/** The name an asset is installed under right now, whatever settings say it should be. */
export function heldName(
  id: string,
  links: readonly Link[],
  native: readonly { id: string; kind: string; key: string }[],
) {
  const held =
    links.find((link) => link.id === id)?.target ??
    native.find((entry) => entry.id === id && entry.kind === "mcp")?.key;

  return held ? basename(held) : undefined;
}

export type SettledNames = {
  /** Invalid assets whose installed folder is gone, so nothing is left to keep. */
  vanished: Set<string>;
  /** Asset ID → local name, as it should be saved in `config.yaml`. */
  localNames: Record<string, string>;
  /** Assets the developer chose to skip or replace for good. */
  disabledAssetIds: string[];
  /** Newcomers left out of this run only. */
  skipped: Set<string>;
  events: SyncEvent[];
};

export async function settleNames(input: {
  assets: SelectionResult["assets"];
  /** Asset ID → why the workspace's copy can't be installed. */
  invalid: ReadonlyMap<string, string>;
  state: State;
  /** `localNames` from settings. */
  savedNames: Record<string, string>;
  /** Asks the developer; without one a newcomer is skipped for this run. */
  resolver: ClashResolver | undefined;
}): Promise<SettledNames> {
  const { assets, invalid, state, savedNames, resolver } = input;
  const { links, native, installed } = state;

  // Installed names share one namespace per kind; resolve clashes before staging.
  const owned = (id: string) =>
    links.some((link) => link.id === id) ||
    native.some((entry) => entry.id === id && entry.kind === "mcp");

  // An invalid asset can only stay installed while its own folder is still there.
  const vanished = new Set<string>();
  for (const entry of installed) {
    if (!invalid.has(entry.id)) {
      continue;
    }

    const actual = await treeFingerprint(entry.path);
    const shared = installed.some(
      (other) => other.id !== entry.id && other.path === entry.path,
    );

    if (actual === null || (shared && actual !== entry.fingerprint)) {
      vanished.add(entry.id);
    }
  }

  // An invalid asset stays under the name it's installed at, whatever it was renamed to since.
  const heldNames = new Map<string, string>();
  for (const { asset, enabled } of assets) {
    if (!enabled || !invalid.has(asset.id) || vanished.has(asset.id)) {
      continue;
    }

    const held = heldName(asset.id, links, native);
    if (held) {
      heldNames.set(asset.id, held);
    }
  }

  const outcome = await resolveClashes(
    [
      ...assets.flatMap(({ asset, enabled }) => {
        const { kind } = asset;
        if (
          !enabled ||
          kind === "hook" ||
          (invalid.has(asset.id) &&
            (!owned(asset.id) || vanished.has(asset.id)))
        ) {
          return [];
        }

        return [
          {
            id: asset.id,
            kind,
            name: asset.name,
            origin: asset.origin,
            installed: owned(asset.id),
            renamable: !invalid.has(asset.id),
          },
        ];
      }),
    ],
    { ...savedNames, ...Object.fromEntries(heldNames) },
    resolver,
  );

  // A held name is for this run; settings keep whatever the developer saved.
  const localNames = { ...outcome.localNames };
  for (const id of heldNames.keys()) {
    if (savedNames[id] === undefined) {
      delete localNames[id];
    } else {
      localNames[id] = savedNames[id];
    }
  }

  return {
    vanished,
    localNames,
    disabledAssetIds: outcome.disabledAssetIds,
    skipped: new Set(outcome.skipped.map((clash) => clash.incoming.id)),
    events: outcome.skipped.map((clash) => ({
      type: "clash",
      kind: clash.kind,
      name: clash.name,
      installed: {
        name: clash.installed.name,
        origin: originLabel(clash.installed.origin),
      },
      skipped: {
        name: clash.incoming.name,
        origin: originLabel(clash.incoming.origin),
        rename: clash.incomingRename,
      },
    })),
  };
}
