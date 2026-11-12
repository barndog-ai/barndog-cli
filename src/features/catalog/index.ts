import { homedir } from "node:os";
import { mcpListSchema } from "@barndog-ai/api-contract";
import { readSettings, type Connection } from "../../config/settings.js";
import { CliError } from "../../errors.js";
import { packageCatalogs } from "../collaboration/remote.js";
import { request } from "../environment/remote.js";
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

async function mcpCatalog(conn: Connection, home: string) {
  const rows: CatalogAsset[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await request(
      conn,
      `/v1/mcps?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      mcpListSchema,
      home,
    );
    for (const mcp of page.mcps) {
      if (mcp.organizationId !== conn.organizationId)
        throw new Error("Invalid catalog organization");
      rows.push({
        id: mcp.id,
        kind: "mcp",
        name: mcp.name,
        origin: mcp.origin,
        version: {
          number: mcp.version.number,
          description: mcp.version.definition.description,
        },
      });
    }
    if (page.nextCursor && seen.has(page.nextCursor))
      throw new Error("Invalid catalog pagination");
    if (page.nextCursor) seen.add(page.nextCursor);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return rows;
}

export async function searchCatalog(
  kind: AssetKind,
  home = homedir(),
): Promise<CatalogAsset[]> {
  const shared = await sharedCatalog(kind, home);
  const settings = await readSettings(home);
  const overlay = settings && localOverlay(settings, home);
  if (!overlay) return shared;
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
  if (repo)
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
  if (!settings || settings.version !== 2 || !settings.connection)
    throw new CliError(
      "This machine isn't connected to a BarnDog workspace.",
      "barndog init",
    );
  const conn = settings.connection;
  if (kind === "mcp") return mcpCatalog(conn, home);
  const packages = await packageCatalogs[kind](conn, home);
  return packages.map((item) => ({
    id: item.id,
    kind,
    name: item.name,
    origin: item.origin,
    version: {
      number: item.version.number,
      description: item.version.description,
    },
  }));
}
