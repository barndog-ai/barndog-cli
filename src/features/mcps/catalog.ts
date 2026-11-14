import { mcpListSchema } from "@barndog-ai/api-contract";
import type { Connection } from "../../config/settings.js";
import type { CatalogAsset } from "../asset-kinds/index.js";
import { request } from "../server/request.js";
import { allPages } from "../server/pages.js";

/**
 * Fetches every MCP catalog page, rejecting organization mismatches and
 * repeated pagination cursors.
 */
export async function mcpCatalog(
  conn: Connection,
  home: string,
): Promise<CatalogAsset[]> {
  return allPages(async (cursor) => {
    const page = await request(
      conn,
      `/v1/mcps?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      mcpListSchema,
      { home },
    );

    const items = page.mcps.map((mcp): CatalogAsset => {
      if (mcp.organizationId !== conn.organizationId) {
        throw new Error(
          "The server sent a catalog page for another organization",
        );
      }

      return {
        id: mcp.id,
        kind: "mcp",
        name: mcp.name,
        origin: mcp.origin,
        version: {
          number: mcp.version.number,
          description: mcp.version.definition.description,
        },
      };
    });

    return { items, nextCursor: page.nextCursor };
  });
}
