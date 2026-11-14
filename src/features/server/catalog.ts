import { z } from "zod";
import {
  environmentCatalogSchema,
  scopeSchema,
} from "@barndog-ai/api-contract";
import { connection } from "./connection.js";
import { connectionContext } from "../auth/session.js";
import { homedir } from "node:os";
import type { Connection } from "../../config/settings.js";
import {
  assetKinds,
  assetNotFound,
  type PublishedAsset,
} from "../asset-kinds/index.js";
import { type AssetKind } from "../../config/selection.js";
import { only } from "../../shared/lookup.js";
import { matchesOrigin } from "./origin.js";
import { request } from "./request.js";
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
