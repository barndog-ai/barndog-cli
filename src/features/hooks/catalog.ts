import type { RuntimeContext } from "../../runtime.js";
import { hookListSchema } from "@barndog-ai/api-contract";
import type { Connection } from "../../config/settings.js";
import type { Hook, CatalogAsset } from "../asset-kinds/index.js";
import { apiClient } from "../auth/transport.js";
import { allPages } from "../server/pages.js";

/** Every published Hook you can see, as the server describes it. */
export async function publishedHooks(
  conn: Connection,
  runtime: RuntimeContext,
): Promise<Hook[]> {
  const client = apiClient(conn.server, runtime);

  return allPages(async (cursor) => {
    const page = hookListSchema.parse(
      (
        await client.GET("/v1/hooks", {
          params: { query: { limit: 100, cursor } },
        })
      ).data,
    );

    if (
      page.hooks.some((hook) => hook.organizationId !== conn.organizationId)
    ) {
      throw new Error(
        "The server sent a catalog page for another organization",
      );
    }

    return { items: page.hooks, nextCursor: page.nextCursor };
  });
}

export async function hookCatalog(
  conn: Connection,
  runtime: RuntimeContext,
): Promise<CatalogAsset[]> {
  return (await publishedHooks(conn, runtime)).map((hook) => ({
    id: hook.id,
    kind: "hook",
    name: hook.name,
    origin: hook.origin,
    version: {
      number: hook.version.number,
      description: hook.version.description,
    },
  }));
}
