import type { RuntimeContext } from "../../runtime.js";
import { CliError } from "../../errors.js";
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
import { type RetryKey, parsed } from "../server/client.js";
import type { AssetKind } from "../../config/selection.js";
import { randomUUID } from "node:crypto";
import { assetKindList } from "../asset-kinds/index.js";
import { only } from "../../shared/lookup.js";
import { allPages, PAGE_SIZE } from "../server/pages.js";
import { apiClient } from "../auth/transport.js";

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
  search: string | undefined,
  runtime: RuntimeContext,
): Promise<Developer[]> {
  const conn = await connection(runtime);

  return allPages(async (cursor) => {
    const page: DeveloperList = await parsed(
      developerListSchema,
      apiClient(conn.server, runtime).GET("/v1/developers", {
        params: { query: { limit: PAGE_SIZE, search, cursor } },
      }),
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
  search: string | undefined,
  runtime: RuntimeContext,
): Promise<DeveloperAssets> {
  const people = await developers(undefined, runtime);
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

  const conn = await connection(runtime);
  const assets = await allPages(async (cursor) => {
    const page: DeveloperAssetPage = await parsed(
      developerAssetsSchema,
      apiClient(conn.server, runtime).GET("/v1/developers/{id}/assets", {
        params: {
          path: { id: developer.id },
          query: { limit: PAGE_SIZE, search, cursor },
        },
      }),
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
  runtime: RuntimeContext,
): Promise<Promotion> {
  const selected = await selectAsset(
    input.kind,
    input.name,
    input.origin,
    runtime,
  );

  const scope = await selectOrigin(input.target, selected.connection, runtime);

  const client = apiClient(selected.connection.server, runtime);
  const params = { path: { kind: input.kind, id: selected.reference.id } };
  const body = {
    name: input.newName,
    origin: { type: scope.type, id: scope.id },
    idempotencyKey: input.key ?? randomUUID(),
  };

  return parsed(
    promotionSchema,
    action === "fork"
      ? client.POST("/v1/environment/{kind}/{id}/fork", {
          params,
          body: forkInputSchema.parse(body),
        })
      : client.POST("/v1/environment/{kind}/{id}/promote", {
          params,
          body: promotionInputSchema.parse(body),
        }),
  );
}

/** Copies an asset into a scope the developer owns; a change ID means it needs review. */
export async function fork(
  input: PromoteInput,
  runtime: RuntimeContext,
): Promise<Promotion> {
  return copyToScope("fork", input, runtime);
}
