import { CliError } from "../../errors.js";
import { homedir } from "node:os";
import { z } from "zod";
import {
  developerListSchema,
  developerAssetsSchema,
  promotionInputSchema,
  forkInputSchema,
} from "@barndog-ai/api-contract";
import { selectOrigin } from "../server/origin.js";
import { connection } from "../server/connection.js";
import { selectAsset } from "../server/catalog.js";
import { type RetryKey, request } from "../server/request.js";
import type { AssetKind } from "../../config/selection.js";
import { randomUUID } from "node:crypto";
import { assetKindList } from "../asset-kinds/index.js";
import { only } from "../../shared/lookup.js";
import { allPages } from "../server/pages.js";

type DeveloperList = z.infer<typeof developerListSchema>;

export type Developer = DeveloperList["developers"][number];

/** One page of a developer's published assets. */
type DeveloperAssetPage = z.infer<typeof developerAssetsSchema>;

/** A developer and every asset they published. */
export type DeveloperAssets = {
  developer: Developer;
  assets: DeveloperAssetPage["assets"];
};

/**
 * Fetches every page of visible developers, optionally filtered by search;
 * repeated cursors are rejected.
 */
export async function developers(
  search?: string,
  home = homedir(),
): Promise<Developer[]> {
  const conn = await connection(home);

  return allPages(async (cursor) => {
    const query = new URLSearchParams({
      limit: "100",
      ...(search ? { search } : {}),
      ...(cursor ? { cursor } : {}),
    });

    const page: DeveloperList = await request(
      conn,
      `/v1/developers?${query}`,
      developerListSchema,
      { home },
    );

    return { items: page.developers, nextCursor: page.nextCursor };
  });
}

/**
 * Resolves a developer by ID or slug and fetches all pages of their visible
 * assets, optionally filtered by search.
 */
export async function developerAssets(
  selector: string,
  search?: string,
  home = homedir(),
): Promise<DeveloperAssets> {
  const people = await developers(undefined, home);
  const matches = people.filter(
    (p) => p.id === selector || p.slug === selector,
  );

  const developer = only(matches);
  if (!developer) {
    throw new CliError(
      `No developer found with that handle.`,
      "barndog people list",
    );
  }

  const conn = await connection(home);
  const assets = await allPages(async (cursor) => {
    const query = new URLSearchParams({
      limit: "100",
      ...(search ? { search } : {}),
      ...(cursor ? { cursor } : {}),
    });

    const page: DeveloperAssetPage = await request(
      conn,
      `/v1/developers/${developer.id}/assets?${query}`,
      developerAssetsSchema,
      { home },
    );

    return { items: page.assets, nextCursor: page.nextCursor };
  });

  return { developer, assets };
}

/**
 * Source and destination selectors for creating a scope-owned asset, with an
 * optional retry key.
 */
export type PromoteInput = {
  kind: AssetKind;
  name: string;
  /** The scope the asset is in now. */
  origin: string;
  /** The scope to create the new asset in. */
  target: string;
  newName: string;
  key?: RetryKey;
};

const promotionSchema = z.object({
  kind: z.enum(assetKindList),
  id: z.uuid(),
  changeId: z.uuid().optional(),
});

export type Promotion = z.infer<typeof promotionSchema>;

export async function copyToScope(
  action: "promote" | "fork",
  input: PromoteInput,
  home: string,
): Promise<Promotion> {
  const selected = await selectAsset(
    input.kind,
    input.name,
    input.origin,
    home,
  );

  const scope = await selectOrigin(input.target, selected.connection, home);

  const schema = action === "fork" ? forkInputSchema : promotionInputSchema;
  const body = schema.parse({
    name: input.newName,
    origin: { type: scope.type, id: scope.id },
    idempotencyKey: input.key ?? randomUUID(),
  });

  return request(
    selected.connection,
    `/v1/environment/${input.kind}/${selected.reference.id}/${action}`,
    promotionSchema,
    { home, method: "POST", body },
  );
}

/** Copies an asset into a scope the developer owns; a change ID means it needs review. */
export async function fork(
  input: PromoteInput,
  home = homedir(),
): Promise<Promotion> {
  return copyToScope("fork", input, home);
}
