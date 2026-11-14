import { mcpListSchema } from "@barndog-ai/api-contract";
import type { Connection } from "../../config/settings.js";
import type { CatalogAsset } from "../asset-kinds/index.js";
import { parsed } from "../server/client.js";
import { allPages, PAGE_SIZE } from "../server/pages.js";
import { apiClient } from "../auth/transport.js";

/**
 * Fetches every MCP catalog page, rejecting organization mismatches and
 * repeated pagination cursors.
 */
export async function mcpCatalog(
  conn: Connection,
  home: string,
): Promise<CatalogAsset[]> {
  return allPages(async (cursor) => {
    const page = await parsed(
      mcpListSchema,
      apiClient(conn.server, home).GET("/v1/mcps", {
        params: { query: { limit: PAGE_SIZE, cursor } },
      }),
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
