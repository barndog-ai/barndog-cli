import { z } from "zod";
import { environmentCatalogSchema, ApiError } from "@barndog-ai/api-contract";
import { serverFetch } from "../auth/transport.js";
import { connection } from "../collaboration/remote.js";
import { connectionContext } from "../skills/remote.js";
import { homedir } from "node:os";
import type { Connection } from "../../config/settings.js";
import {
  assetKinds,
  assetNotFound,
  type AssetKind,
} from "../asset-kinds/index.js";
import { only } from "../../shared/lookup.js";

/**
 * A caller-chosen idempotency key. Sending the same key again retries the
 * same write instead of repeating it, so keep it until the write is confirmed.
 */
export type RetryKey = string;

export async function request<T>(
  conn: Connection,
  path: string,
  schema: z.ZodType<T>,
  home = homedir(),
  method = "GET",
  body?: unknown,
): Promise<T> {
  if (!path.startsWith("/v1/") || path.includes(".."))
    throw new Error("Invalid API path");
  const response = await serverFetch(conn.server, home)(
    `${conn.server}${path}`,
    {
      method,
      headers:
        body instanceof FormData
          ? undefined
          : body === undefined
            ? undefined
            : { "Content-Type": "application/json" },
      body:
        body instanceof FormData
          ? body
          : body === undefined
            ? undefined
            : JSON.stringify(body),
    },
  );
  if (!response.ok) {
    const error = z
      .object({ code: z.string(), message: z.string() })
      .safeParse(await response.json().catch(() => null));
    throw new ApiError(
      response.status,
      error.success ? error.data.code : "REQUEST_FAILED",
      error.success
        ? error.data.message
        : `Request failed (${response.status})`,
    );
  }
  return schema.parse(await response.json());
}

export async function environmentCatalog(
  home = homedir(),
  expected?: Connection,
): Promise<{
  connection: Connection;
  catalog: z.infer<typeof environmentCatalogSchema>;
}> {
  const conn = expected
    ? await connectionContext(expected.server, home)
    : await connection(home);
  if (
    expected &&
    (conn.organizationId !== expected.organizationId ||
      conn.developerId !== expected.developerId)
  )
    throw new Error(
      "Authenticated identity does not match the selected environment",
    );
  return {
    connection: conn,
    catalog: await request(
      conn,
      "/v1/environment/catalog",
      environmentCatalogSchema,
      home,
    ),
  };
}

export async function getAsset(
  kind: AssetKind,
  id: string,
  conn: Connection,
  home = homedir(),
) {
  const path = `/v1/${assetKinds[kind].route}/${z.uuidv4().parse(id)}`;
  return assetKinds[kind].schema.parse(
    await request(conn, path, z.unknown(), home),
  );
}

export async function selectAsset(
  kind: AssetKind,
  name: string,
  origin: string,
  home = homedir(),
) {
  const { connection: conn, catalog } = await environmentCatalog(home);
  const { matchesOrigin } = await import("../collaboration/remote.js");
  const matches = catalog.assets.filter(
    (a) =>
      a.kind === kind &&
      (a.id === name || a.name === name) &&
      matchesOrigin(a.origin, origin, conn),
  );
  const reference = only(matches);
  if (!reference) throw assetNotFound(kind, name, origin);
  return {
    connection: conn,
    reference,
    asset: await getAsset(kind, reference.id, conn, home),
  };
}
