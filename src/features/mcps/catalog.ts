import { mcpListSchema } from "@barndog-ai/api-contract";
import type { Connection } from "../../config/settings.js";
import type { CatalogAsset } from "../catalog/index.js";
import { request } from "../environment/remote.js";

/**
 * Fetches every MCP catalog page, rejecting organization mismatches and
 * repeated pagination cursors.
 */
export async function mcpCatalog(
  conn: Connection,
  home: string,
): Promise<CatalogAsset[]> {
  const rows: CatalogAsset[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await request(
      conn,
      `/v1/mcps?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      mcpListSchema,
      { home },
    );

    for (const mcp of page.mcps) {
      if (mcp.organizationId !== conn.organizationId) {
        throw new Error("Invalid catalog organization");
      }

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

    if (page.nextCursor && seen.has(page.nextCursor)) {
      throw new Error("Invalid catalog pagination");
    }

    if (page.nextCursor) {
      seen.add(page.nextCursor);
    }

    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  return rows;
}
