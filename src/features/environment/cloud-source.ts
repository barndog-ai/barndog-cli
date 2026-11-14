import { mcpSchema } from "@barndog-ai/api-contract";
import { assetKinds } from "../asset-kinds/index.js";

import type { Connection } from "../../config/settings.js";
import type { AssetKind, AssetReference } from "../asset-selection/types.js";
import { cacheKey, cachedPackage } from "./packages.js";
import { environmentCatalog, getAsset } from "./remote.js";
import type { WorkspaceSource } from "./source.js";

async function currentAsset(
  kind: AssetKind,
  reference: AssetReference,
  conn: Connection,
  home: string,
) {
  const data = await getAsset(kind, reference.id, conn, home);
  if (
    data.id !== reference.id ||
    data.version.id !== reference.publishedVersion ||
    data.name !== reference.name ||
    data.organizationId !== conn.organizationId
  ) {
    throw new Error("Catalog changed during staging; retry sync");
  }

  return data;
}

/**
 * Adapts an authenticated cloud connection to lazy catalog, package-cache and
 * MCP reads for synchronization.
 */
export function cloudSource(conn: Connection, home: string): WorkspaceSource {
  return {
    cacheKey: cacheKey(conn),
    journal: conn,
    catalog: async () => (await environmentCatalog(home, conn)).catalog,
    skillOrHookPackage: async (kind, reference) => {
      const data = await currentAsset(kind, reference, conn, home);

      return cachedPackage(
        kind,
        assetKinds[kind].schema.parse(data),
        conn,
        home,
      );
    },
    mcpDefinition: async (reference) =>
      mcpSchema.parse(await currentAsset("mcp", reference, conn, home)).version
        .definition,
    invalidAssets: () => Promise.resolve(new Map()),
    notices: () => [],
  };
}
