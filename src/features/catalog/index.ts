import { homedir } from "node:os";
import { readSettings, type Connection } from "../../config/settings.js";
import { CliError } from "../../errors.js";
import { hookCatalog } from "../hooks/catalog.js";
import { mcpCatalog } from "../mcps/catalog.js";
import { skillCatalog } from "../skills/remote.js";
import { openRepoSource } from "../environment/workspace-source.js";
import { activeLocal, localOverlay } from "../git-workspace/overlay.js";
import type { AssetKind } from "../asset-selection/types.js";

/** One row of the published catalog, neutral across asset kinds. */
export type CatalogAsset = {
  id: string;
  kind: AssetKind;
  name: string;
  origin: { type: string; id: string; slug: string; localOnly?: boolean };
  version: { number: number; description: string; label?: string };
};

type CatalogFetcher = (
  conn: Connection,
  home: string,
) => Promise<CatalogAsset[]>;

/** Beside the code that calls them, because each imports a network module. */
const catalogFetchers: Record<AssetKind, CatalogFetcher> = {
  skill: skillCatalog,
  mcp: mcpCatalog,
  hook: hookCatalog,
};

/**
 * Combines the shared Git or Cloud catalog with valid active local assets of
 * the requested kind.
 */
export async function searchCatalog(
  kind: AssetKind,
  home = homedir(),
): Promise<CatalogAsset[]> {
  const shared = await sharedCatalog(kind, home);
  const settings = await readSettings(home);
  const overlay = settings && localOverlay(settings, home);
  if (!overlay) {
    return shared;
  }

  const { model, assets } = await activeLocal(overlay, shared);

  return [
    ...shared,
    ...assets
      .filter((asset) => asset.kind === kind && !asset.invalid)
      .map((asset) => ({
        id: asset.id,
        kind,
        name: asset.name,
        origin: {
          type: "dev",
          id: model.organizationId,
          slug: "local",
          localOnly: true,
        },
        version: {
          number: 0,
          description: asset.description,
          label: asset.publishedVersion.slice(0, 7),
        },
      })),
  ];
}

async function sharedCatalog(
  kind: AssetKind,
  home: string,
): Promise<CatalogAsset[]> {
  const settings = await readSettings(home);
  const repo = settings && openRepoSource(settings, home, { refresh: "auto" });
  if (repo) {
    return (await repo.model()).assets
      .filter((asset) => asset.kind === kind && !asset.invalid)
      .map((asset) => ({
        id: asset.id,
        kind,
        name: asset.name,
        origin: asset.origin,
        version: {
          number: 0,
          description: asset.description,
          label: asset.publishedVersion.slice(0, 7),
        },
      }));
  }

  if (!settings || !settings.connection) {
    throw new CliError(
      "This machine isn't connected to a BarnDog workspace.",
      "barndog init",
    );
  }

  return catalogFetchers[kind](settings.connection, home);
}
