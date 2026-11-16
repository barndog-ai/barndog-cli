import type { RuntimeContext } from "../../runtime.js";
import { z } from "zod";
import { environmentCatalogSchema } from "@barndog-ai/api-contract";
import { connection } from "./connection.js";
import { connectionContext } from "../auth/session.js";
import type { Connection } from "../../config/settings.js";
import {
  assetKinds,
  assetNotFound,
  type PublishedAsset,
} from "../asset-kinds/index.js";
import { type AssetKind } from "../../config/selection.js";
import { only } from "../../shared/lookup.js";
import { matchesOrigin } from "./origin.js";
import { type ApiClient, apiClient } from "../auth/transport.js";
import { parsed, responseData } from "./client.js";
import { CliError } from "../../errors.js";

/** Every asset this developer can install, as the server lists them. */
export type EnvironmentCatalog = z.infer<typeof environmentCatalogSchema>;

/** A scope as the server describes it, with its name and whether you can publish there. */

type CatalogEntry = EnvironmentCatalog["assets"][number];

/** An asset picked from the catalog by name and origin, with its full description. */
export type SelectedAsset = {
  connection: Connection;
  reference: CatalogEntry;
  asset: PublishedAsset;
};

/**
 * Fetches the environment catalog and authenticated connection, rejecting a
 * mismatch with an expected saved identity.
 */
export async function environmentCatalog(
  runtime: RuntimeContext,
  expected?: Connection,
): Promise<{ connection: Connection; catalog: EnvironmentCatalog }> {
  const conn = expected
    ? await connectionContext(expected.server, runtime)
    : await connection(runtime);

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
    catalog: await parsed(
      environmentCatalogSchema,
      apiClient(conn.server, runtime).GET("/v1/environment/catalog"),
    ),
  };
}

export async function getAsset(
  kind: AssetKind,
  id: string,
  conn: Connection,
  runtime: RuntimeContext,
): Promise<PublishedAsset> {
  return assetKinds[kind].schema.parse(
    responseData(
      await assetRoutes[kind](
        apiClient(conn.server, runtime),
        // Only a UUID may reach the URL.
        z.uuidv4().parse(id),
      ),
    ),
  );
}

/** The route that returns one published asset of each kind. */
const assetRoutes: Record<
  AssetKind,
  (client: ApiClient, id: string) => Promise<{ data?: unknown }>
> = {
  skill: (client, id) =>
    client.GET("/v1/skills/{id}", { params: { path: { id } } }),
  hook: (client, id) =>
    client.GET("/v1/hooks/{id}", { params: { path: { id } } }),
  mcp: (client, id) =>
    client.GET("/v1/mcps/{id}", { params: { path: { id } } }),
};

/**
 * Resolves one catalog asset by name or ID and origin, then fetches its
 * published content; ambiguous matches fail.
 */
export async function selectAsset(
  kind: AssetKind,
  name: string,
  origin: string,
  runtime: RuntimeContext,
): Promise<SelectedAsset> {
  const { connection: conn, catalog } = await environmentCatalog(runtime);
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
    asset: await getAsset(kind, reference.id, conn, runtime),
  };
}
