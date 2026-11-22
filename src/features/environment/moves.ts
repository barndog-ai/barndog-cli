/**
 * Finishes `barndog local move` once the shared copy exists. An unchanged local
 * copy is deleted and the shared one takes its place; one edited since the move
 * stays as a separate local asset. Either way the move record goes away, so no
 * asset stays half-moved.
 */
import type { RuntimeContext } from "../../runtime.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { SelectionState } from "../../config/selection.js";
import { resolveAssets } from "../asset-selection/index.js";
import {
  updateKeptValues,
  withMovedServers,
  type ServerMove,
} from "./kept-values.js";
import type { AssetCatalog, AssetReference } from "../asset-selection/types.js";
import { forgetImport } from "../imports/local.js";
import { saveSettings, type Settings } from "../../config/settings.js";
import { withSelection } from "../../config/environment.js";
import {
  localOverlay,
  moveDestination,
  readMoved,
  recordMoved,
  type MovedAsset,
} from "../workspace/overlay.js";
import {
  openRepoSource,
  openWorkspaceSource,
} from "../workspace/workspace-source.js";
import type { RepoSource } from "../workspace/repo-source.js";
import type { WorkspaceSource } from "../workspace/source.js";
import { treeFingerprint } from "../workspace/tree.js";
import type { RepoAsset, WorkspaceModel } from "../workspace/format.js";

/** What finishing the moves changed. */
type SettledMoves = {
  selection: SelectionState;
  /** A sentence for each move that finished or is still waiting. */
  notices: string[];
  /** Whether a local folder or file was deleted, so the catalog must be read again. */
  removedLocal: boolean;
};

type SettleInput = {
  overlay: RepoSource;
  /** Reads the shared workspace too; used to compare a move recorded without its version. */
  source: WorkspaceSource;
  catalog: AssetCatalog;
  selection: SelectionState;
  /** Knowledge document names in the shared workspace; null when they can't be listed here. */
  sharedKnowledge: () => Promise<readonly string[] | null>;
  /** False for a dry run: nothing is deleted or recorded. */
  persist: boolean;
  /** Saves the selection with the shared copies in it, before any local copy is deleted. */
  saveSelection: (selection: SelectionState) => Promise<void>;
  runtime: RuntimeContext;
};

const targetOf = (entry: MovedAsset) => entry.target ?? "the shared workspace";

const waiting = (entry: MovedAsset) =>
  `${entry.name} is still moving to ${moveDestination(entry)}. Your local copy stays in use until that merges.`;

/** Whether the local copy still holds exactly what was moved. */
async function unchanged(
  entry: MovedAsset,
  local: RepoAsset,
  shared: AssetReference,
  input: SettleInput,
) {
  if (entry.version) {
    return local.publishedVersion === entry.version;
  }

  // Moves recorded before versions were kept: compare with the shared copy.
  if (local.kind === "mcp") {
    return isDeepStrictEqual(
      await input.source.mcpDefinition(shared),
      local.definition,
    );
  }

  const folder = await input.source.packageFolder(local.kind, shared);

  return (
    (await treeFingerprint(folder, input.runtime)) ===
    (await treeFingerprint(
      join(input.overlay.label, local.path),
      input.runtime,
    ))
  );
}

/** Where a knowledge move stands; Cloud knowledge is published at once, so only Git waits. */
async function knowledgeOutcome(
  entry: MovedAsset,
  model: WorkspaceModel,
  input: SettleInput,
): Promise<"waiting" | "gone" | "changed" | "unchanged"> {
  const doc = model.knowledge.find((d) => d.path === entry.path);
  if (!doc) {
    return "gone";
  }

  // Recorded before versions were kept, and Cloud knowledge can't be compared here.
  if (!entry.version) {
    return "changed";
  }

  if (!(await input.sharedKnowledge())?.includes(entry.name)) {
    return "waiting";
  }

  return doc.version === entry.version ? "unchanged" : "changed";
}

/** Only paths the local workspace's own model lists get here, so they stay inside it. */
async function removeLocal(entry: MovedAsset, input: SettleInput) {
  await rm(join(input.overlay.label, entry.path), {
    recursive: true,
    force: true,
  });

  await forgetImport(input.overlay.label, entry.kind, entry.name);
}

/** Kept MCP values follow each moved server to its shared copy. */
async function carryKeptValues(
  servers: readonly ServerMove[],
  runtime: RuntimeContext,
) {
  if (servers.length) {
    await updateKeptValues(
      (secrets) => withMovedServers(secrets, servers),
      runtime,
    );
  }
}

async function settleMoves(input: SettleInput): Promise<SettledMoves> {
  const records = await readMoved(input.overlay.label);
  if (!records.length) {
    return { selection: input.selection, notices: [], removedLocal: false };
  }

  const model = await input.overlay.model();
  const selected = new Set(
    resolveAssets(input.catalog, input.selection).assets.map(
      (entry) => entry.asset.id,
    ),
  );

  const ids = [...input.selection.individualAssetIds];
  const notices: string[] = [];
  const finished: string[] = [];

  const removals: MovedAsset[] = [];
  const servers: (ServerMove & { kind: MovedAsset["kind"] })[] = [];

  const finish = (entry: MovedAsset, keep: boolean) => {
    finished.push(entry.path);
    if (keep) {
      notices.push(
        `${entry.name} changed after it was moved to ${targetOf(entry)}, so your local copy stays as a separate asset.`,
      );

      return;
    }

    removals.push(entry);
    notices.push(
      `${entry.name} moved to ${targetOf(entry)}. Removed the local copy at ${join(input.overlay.label, entry.path)}.`,
    );
  };

  for (const entry of records) {
    if (entry.kind === "knowledge") {
      const outcome = await knowledgeOutcome(entry, model, input);
      if (outcome === "waiting") {
        notices.push(waiting(entry));
      } else if (outcome === "gone") {
        finished.push(entry.path);
      } else {
        finish(entry, outcome === "changed");
      }

      continue;
    }

    const shared = input.catalog.assets.find(
      (asset) =>
        !asset.origin.localOnly &&
        asset.kind === entry.kind &&
        asset.name === entry.name &&
        asset.origin.id === entry.originId,
    );

    if (!shared) {
      notices.push(waiting(entry));
      continue;
    }

    if (!selected.has(shared.id) && !ids.includes(shared.id)) {
      ids.push(shared.id);
    }

    const local = model.assets.find((asset) => asset.path === entry.path);
    if (!local) {
      finished.push(entry.path);
      continue;
    }

    const keep = !(await unchanged(entry, local, shared, input));
    servers.push({
      kind: entry.kind,
      from: local.id,
      to: shared.id,
      copy: keep,
    });

    finish(entry, keep);
  }

  const selection =
    ids.length === input.selection.individualAssetIds.length
      ? input.selection
      : { ...input.selection, individualAssetIds: ids };

  if (input.persist && finished.length) {
    // Saved first, so an interrupted sync can't leave an asset with neither copy.
    await input.saveSelection(selection);
    await carryKeptValues(
      servers.filter((server) => server.kind === "mcp"),
      input.runtime,
    );

    for (const entry of removals) {
      await removeLocal(entry, input);
    }

    await recordMoved(input.overlay.label, [], finished);
  }

  return {
    selection,
    notices,
    removedLocal: input.persist && removals.length > 0,
  };
}

/**
 * A machine that stopped using a Git or Cloud workspace can't finish moves
 * into it, so they end here and the local copies stay as they are.
 */
async function dropUnreachable(settings: Settings, persist: boolean) {
  const folder = settings.localWorkspace?.path;
  const records = folder ? await readMoved(folder) : [];
  if (!folder || !records.length || !persist) {
    return [];
  }

  await recordMoved(
    folder,
    [],
    records.map((entry) => entry.path),
  );

  return [
    `This machine no longer uses the workspace ${records.map((entry) => entry.name).join(", ")} ${records.length === 1 ? "was" : "were"} moving to, so ${records.length === 1 ? "its local copy stays" : "their local copies stay"} as ${records.length === 1 ? "it is" : "they are"}.`,
  ];
}

/** What sync works from after finishing the moves it can. */
type FinishedMoves = {
  source: WorkspaceSource | undefined;
  catalog: AssetCatalog;
  selection: SelectionState;
  notices: string[];
};

/**
 * Finishes the moves whose shared copy exists. When a local copy was deleted,
 * the catalog read before it still lists that copy, so it is read again
 * unless the caller supplied it (`reread` false).
 */
export async function finishMoves(input: {
  settings: Settings;
  source: WorkspaceSource | undefined;
  catalog: AssetCatalog;
  selection: SelectionState;
  /** Sync's own options: a dry run changes nothing, and a supplied catalog isn't read again. */
  options: {
    dryRun?: boolean;
    source?: WorkspaceSource;
    catalog?: AssetCatalog;
  };
  configPath: string | undefined;
  runtime: RuntimeContext;
}): Promise<FinishedMoves> {
  const { settings, source, options, runtime } = input;
  // A one-off --config delivery never changes what this machine keeps.
  const persist = !options.dryRun && !input.configPath;
  const reread = !options.source && !options.catalog;
  const overlay = localOverlay(settings, runtime);
  if (!overlay || !source) {
    return {
      source,
      catalog: input.catalog,
      selection: input.selection,
      notices: await dropUnreachable(settings, persist),
    };
  }

  const moves = await settleMoves({
    overlay,
    source,
    catalog: input.catalog,
    selection: input.selection,
    sharedKnowledge: async () =>
      settings.gitWorkspace
        ? ((
            await openRepoSource(settings, runtime, {
              refresh: "none",
            })?.model()
          )?.knowledge.map((doc) => doc.content.name) ?? null)
        : null,
    persist,
    saveSelection: (next) =>
      saveSettings(withSelection(settings, next), runtime.home),
    runtime,
  });

  if (!moves.removedLocal || !reread) {
    return { source, catalog: input.catalog, ...moves };
  }

  const fresh =
    openWorkspaceSource(settings, runtime, { refresh: "none" }) ?? source;

  return { source: fresh, catalog: await fresh.catalog(), ...moves };
}
