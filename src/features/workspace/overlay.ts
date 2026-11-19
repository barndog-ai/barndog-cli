import type { RuntimeContext } from "../../runtime.js";
import type { Settings } from "../../config/settings.js";
import type { AssetCatalog, AssetReference } from "../asset-selection/types.js";
import type { SelectionState } from "../../config/selection.js";
import type { WorkspaceSource } from "./source.js";
import type { WorkspaceModel } from "./format.js";
import { localRepoSource, type RepoSource } from "./repo-source.js";
import { z } from "zod";
import { localWorkspaceFiles } from "../../config/paths.js";
import { readJsonIfExists, writeAtomic } from "../../shared/files.js";
import { POSIX_MODE } from "../../shared/constants.js";
import { rm } from "node:fs/promises";

/** How assets in the kept local folder are addressed next to a shared workspace. */
export const LOCAL_ORIGIN = "local";

const movedSchema = z.array(
  z.looseObject({
    kind: z.string(),
    path: z.string(),
    name: z.string(),
    /** Scope it was moved to; knowledge has none. */
    originId: z.string().optional(),
    /**
     * The local version that was moved, so an edit made since keeps the local
     * copy. Moves recorded before this was kept have none.
     */
    version: z.string().optional(),
    /** Where it went, as `local list` names it: a scope or a repository. */
    target: z.string().optional(),
    /** The pull request it waits for, when the move needs a review. */
    url: z.string().nullable().optional(),
  }),
);

/**
 * A local asset on its way to the shared workspace: it stays in use until the
 * shared copy exists, then sync replaces it with that copy.
 */
export type MovedAsset = z.infer<typeof movedSchema>[number];

/** Where a move is going, as people read it: its pull request, else the destination. */
export const moveDestination = (entry: MovedAsset) =>
  entry.url ?? entry.target ?? "the shared workspace";

/**
 * Reads and validates movement records in a workspace folder; an absent file
 * means nothing is moving.
 */
export async function readMoved(folder: string): Promise<MovedAsset[]> {
  return (
    (await readJsonIfExists(localWorkspaceFiles(folder).moved, movedSchema)) ??
    []
  );
}

/**
 * Writes movement records in the folder, replacing prior entries with the same
 * local path and dropping the `finished` ones.
 */
export async function recordMoved(
  folder: string,
  added: MovedAsset[],
  finished: readonly string[] = [],
) {
  const kept = (await readMoved(folder)).filter(
    (entry) =>
      !finished.includes(entry.path) &&
      !added.some((asset) => asset.path === entry.path),
  );

  const next = [...kept, ...added];
  if (!next.length) {
    await rm(localWorkspaceFiles(folder).moved, { force: true });

    return;
  }

  await writeAtomic(
    localWorkspaceFiles(folder).moved,
    JSON.stringify(next, null, 2) + "\n",
    { mode: POSIX_MODE.regularFile },
  );
}

/** The local folder, when it runs alongside a Git or Cloud workspace. */
export function localOverlay(
  settings: Settings,
  runtime: RuntimeContext,
): RepoSource | undefined {
  if (
    !settings.localWorkspace ||
    (!settings.connection && !settings.gitWorkspace)
  ) {
    return undefined;
  }

  return localRepoSource(settings.localWorkspace, runtime);
}

/** Local copies step aside once what was moved exists in the shared workspace. */
export async function activeLocal(
  overlay: RepoSource,
  shared: { kind: string; name: string; origin?: { id: string } }[],
) {
  const model = await overlay.model();
  const moved = await readMoved(overlay.label);
  const retired = (kind: string, path: string) =>
    moved.some(
      (entry) =>
        entry.kind === kind &&
        entry.path === path &&
        shared.some(
          (s) =>
            s.kind === kind &&
            s.name === entry.name &&
            (!entry.originId || s.origin?.id === entry.originId),
        ),
    );

  return {
    model,
    assets: model.assets.filter((asset) => !retired(asset.kind, asset.path)),
    knowledge: model.knowledge.filter((doc) => !retired("knowledge", doc.path)),
  };
}

/**
 * Adds active local assets and their recommended distribution to a shared
 * catalog without mutating the input.
 */
export async function mergeLocalCatalog(
  catalog: AssetCatalog,
  overlay: RepoSource,
): Promise<AssetCatalog> {
  const { model, assets } = await activeLocal(overlay, [...catalog.assets]);
  const local: AssetReference[] = assets.map((asset) => ({
    kind: asset.kind,
    id: asset.id,
    name: asset.name,
    origin: {
      type: "dev",
      id: model.organizationId,
      slug: "local",
      localOnly: true,
    } as const,
    publishedVersion: asset.publishedVersion,
  }));

  return {
    assets: [...catalog.assets, ...local],
    distributions: [
      ...catalog.distributions,
      {
        scope: { type: "org", id: model.organizationId },
        assets: local.map((asset) => ({
          assetId: asset.id,
          mode: "recommended" as const,
        })),
      },
    ],
  };
}

/** Keeps every local asset selected, including ones added to the folder later. */
export function withLocalSubscription(
  state: SelectionState,
  model: WorkspaceModel,
): SelectionState {
  return state.subscriptions.some((s) => s.scope.id === model.organizationId)
    ? state
    : {
        ...state,
        subscriptions: [
          ...state.subscriptions,
          {
            scope: { type: "org", id: model.organizationId },
            mode: "all",
            enabled: true,
          },
        ],
      };
}

/** Lets sync read a shared workspace and the kept local folder as one source. */
export function withOverlay(
  primary: WorkspaceSource,
  overlay: RepoSource,
): WorkspaceSource {
  const owner = async (reference: AssetReference) =>
    (await overlay.model()).assets.some((asset) => asset.id === reference.id)
      ? overlay
      : primary;

  return {
    cacheKey: primary.cacheKey,
    extraCacheKeys: [overlay.cacheKey],
    journal: primary.journal,
    catalog: async () => mergeLocalCatalog(await primary.catalog(), overlay),
    packageFolder: async (kind, reference) =>
      (await owner(reference)).packageFolder(kind, reference),
    mcpDefinition: async (reference) =>
      (await owner(reference)).mcpDefinition(reference),
    invalidAssets: async () =>
      new Map([
        ...(await primary.invalidAssets()),
        ...(await overlay.invalidAssets()),
      ]),
    notices: () => [...primary.notices(), ...overlay.notices()],
  };
}
