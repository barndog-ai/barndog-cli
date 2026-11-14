import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Settings } from "../../config/settings.js";
import type { AssetCatalog, AssetReference } from "../asset-selection/types.js";
import type { SelectionState } from "../../config/selection.js";
import { resolveAssets } from "../asset-selection/index.js";
import type { WorkspaceSource } from "./source.js";
import type { WorkspaceModel } from "./format.js";
import { localRepoSource, type RepoSource } from "./repo-source.js";
import { errorCode } from "../../shared/values.js";
import { z } from "zod";

/** How assets in the kept local folder are addressed next to a shared workspace. */
export const LOCAL_ORIGIN = "local";

const MOVED_FILE = ".barndog-moved.json";

const movedSchema = z.array(
  z.looseObject({
    kind: z.string(),
    path: z.string(),
    name: z.string(),
    /** Scope it was moved to; knowledge has none. */
    originId: z.string().optional(),
    /** Set once the shared copy was selected, so removing it later sticks. */
    adopted: z.boolean().optional(),
  }),
);

/**
 * Persisted local path and shared destination metadata used to track moved
 * assets.
 */
export type MovedAsset = z.infer<typeof movedSchema>[number];

/**
 * Reads and validates movement records in a workspace folder; an absent file
 * means nothing has moved.
 */
export async function readMoved(folder: string): Promise<MovedAsset[]> {
  try {
    return movedSchema.parse(
      JSON.parse(await readFile(join(folder, MOVED_FILE), "utf8")),
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }

    throw error;
  }
}

/**
 * Writes movement records in the folder, replacing prior entries with the same
 * local path.
 */
export async function recordMoved(folder: string, added: MovedAsset[]) {
  const kept = (await readMoved(folder)).filter(
    (entry) => !added.some((asset) => asset.path === entry.path),
  );

  await writeFile(
    join(folder, MOVED_FILE),
    JSON.stringify([...kept, ...added], null, 2) + "\n",
  );
}

/** The local folder, when it runs alongside a Git or Cloud workspace. */
export function localOverlay(
  settings: Settings,
  home: string,
): RepoSource | undefined {
  if (
    !settings.localWorkspace ||
    (!settings.connection && !settings.gitWorkspace)
  ) {
    return undefined;
  }

  return localRepoSource(settings.localWorkspace, home);
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

/** Once a moved asset exists in the shared workspace, this machine uses that copy. */
export async function adoptMoved(
  overlay: RepoSource,
  catalog: AssetCatalog,
  state: SelectionState,
  persist: boolean,
): Promise<SelectionState> {
  const moved = await readMoved(overlay.label);
  const selected = new Set(
    resolveAssets(catalog, state).assets.map((entry) => entry.asset.id),
  );

  const ids = [...state.individualAssetIds];
  const adopted: MovedAsset[] = [];
  for (const entry of moved) {
    if (entry.adopted || !entry.originId) {
      continue;
    }

    const asset = catalog.assets.find(
      (a) =>
        a.kind === entry.kind &&
        a.name === entry.name &&
        a.origin.id === entry.originId,
    );

    if (!asset) {
      continue;
    }

    if (!selected.has(asset.id)) {
      ids.push(asset.id);
    }

    adopted.push({ ...entry, adopted: true });
  }

  if (persist && adopted.length) {
    await recordMoved(overlay.label, adopted);
  }

  return ids.length === state.individualAssetIds.length
    ? state
    : { ...state, individualAssetIds: ids };
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
    skillOrHookPackage: async (kind, reference) =>
      (await owner(reference)).skillOrHookPackage(kind, reference),
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
