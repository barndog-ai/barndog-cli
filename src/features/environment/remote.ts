import { z } from "zod";
import {
  environmentCatalogSchema,
  scopeSchema,
  ApiError,
} from "@barndog-ai/api-contract";
import { serverFetch } from "../auth/transport.js";
import { connection } from "../collaboration/remote.js";
import { connectionContext } from "../auth/session.js";
import { homedir } from "node:os";
import type { Connection } from "../../config/settings.js";
import {
  assetKinds,
  assetNotFound,
  type AssetKind,
  type PublishedAsset,
} from "../asset-kinds/index.js";
import { only } from "../../shared/lookup.js";
import { CliError } from "../../errors.js";

/** Every asset this developer can install, as the server lists them. */
export type EnvironmentCatalog = z.infer<typeof environmentCatalogSchema>;

/** A scope as the server describes it, with its name and whether you can publish there. */
export type ApiScope = z.infer<typeof scopeSchema>;

type CatalogEntry = EnvironmentCatalog["assets"][number];

/** An asset picked from the catalog by name and origin, with its full description. */
export type SelectedAsset = {
  connection: Connection;
  reference: CatalogEntry;
  asset: PublishedAsset;
};

/**
 * A caller-chosen idempotency key. Sending the same key again retries the
 * same write instead of repeating it, so keep it until the write is confirmed.
 */
export type RetryKey = string;

/** Sends `FormData` as it is and anything else defined as JSON. */
function requestBody(body: unknown): {
  headers?: HeadersInit;
  body?: BodyInit;
} {
  if (body instanceof FormData) {
    return { body };
  }

  if (body === undefined) {
    return {};
  }

  return {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * Sends an authenticated /v1/ request and validates JSON against the supplied
 * schema; non-success responses throw ApiError.
 */
export async function request<T>(
  conn: Connection,
  path: string,
  schema: z.ZodType<T>,
  {
    home = homedir(),
    method = "GET",
    body,
  }: { home?: string; method?: string; body?: unknown } = {},
): Promise<T> {
  if (!path.startsWith("/v1/") || path.includes("..")) {
    throw new Error("Invalid API path");
  }

  const response = await serverFetch(conn.server, home)(
    `${conn.server}${path}`,
    {
      method,
      ...requestBody(body),
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

/**
 * Fetches the environment catalog and authenticated connection, rejecting a
 * mismatch with an expected saved identity.
 */
export async function environmentCatalog(
  home = homedir(),
  expected?: Connection,
): Promise<{ connection: Connection; catalog: EnvironmentCatalog }> {
  const conn = expected
    ? await connectionContext(expected.server, home)
    : await connection(home);

  if (
    expected &&
    (conn.organizationId !== expected.organizationId ||
      conn.developerId !== expected.developerId)
  ) {
    throw new CliError(
      "You're signed in as a different organization or developer than this machine was set up with.",
      "barndog login",
    );
  }

  return {
    connection: conn,
    catalog: await request(
      conn,
      "/v1/environment/catalog",
      environmentCatalogSchema,
      { home },
    ),
  };
}

export async function getAsset(
  kind: AssetKind,
  id: string,
  conn: Connection,
  home = homedir(),
): Promise<PublishedAsset> {
  const path = `/v1/${assetKinds[kind].route}/${z.uuidv4().parse(id)}`;

  return assetKinds[kind].schema.parse(
    await request(conn, path, z.unknown(), { home }),
  );
}

/**
 * Resolves one catalog asset by name or ID and origin, then fetches its
 * published content; ambiguous matches fail.
 */
export async function selectAsset(
  kind: AssetKind,
  name: string,
  origin: string,
  home = homedir(),
): Promise<SelectedAsset> {
  const { connection: conn, catalog } = await environmentCatalog(home);
  const { matchesOrigin } = await import("../collaboration/remote.js");
  const matches = catalog.assets.filter(
    (a) =>
      a.kind === kind &&
      (a.id === name || a.name === name) &&
      matchesOrigin(a.origin, origin, conn),
  );

  const reference = only(matches);
  if (!reference) {
    throw assetNotFound(kind, name, origin);
  }

  return {
    connection: conn,
    reference,
    asset: await getAsset(kind, reference.id, conn, home),
  };
}
