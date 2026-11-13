import { hookListSchema, type hookSchema } from "@barndog-ai/api-contract";
import type { z } from "zod";
import type { Connection } from "../../config/settings.js";
import type { CatalogAsset } from "../catalog/index.js";
import { apiClient } from "../skills/remote.js";

export type Hook = z.infer<typeof hookSchema>;

/** Every published Hook you can see, as the server describes it. */
export async function publishedHooks(
  conn: Connection,
  home: string,
): Promise<Hook[]> {
  const client = apiClient(conn.server, home);
  const hooks: Hook[] = [];
  const seen = new Set<string>();

  let cursor: string | undefined;
  do {
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
      throw new Error("Invalid catalog organization");
    }

    hooks.push(...page.hooks);
    if (page.nextCursor && seen.has(page.nextCursor)) {
      throw new Error("Invalid catalog pagination");
    }

    if (page.nextCursor) {
      seen.add(page.nextCursor);
    }

    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  return hooks;
}

export async function hookCatalog(
  conn: Connection,
  home: string,
): Promise<CatalogAsset[]> {
  return (await publishedHooks(conn, home)).map((hook) => ({
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
