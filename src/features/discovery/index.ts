import { CliError } from "../../errors.js";
import { homedir } from "node:os";
import { z } from "zod";
import {
  developerListSchema,
  developerAssetsSchema,
  promotionInputSchema,
  forkInputSchema,
} from "@barndog-ai/api-contract";
import { connection, selectOrigin } from "../collaboration/remote.js";
import { request, selectAsset, type RetryKey } from "../environment/remote.js";
import type { AssetKind } from "../asset-selection/types.js";
import { randomUUID } from "node:crypto";
import { moveLocalAssets, type MoveResult } from "../git-workspace/move.js";
import { LOCAL_ORIGIN } from "../git-workspace/overlay.js";
import { assetKindList } from "../asset-kinds/index.js";
import { only } from "../../shared/lookup.js";

type DeveloperList = z.infer<typeof developerListSchema>;

export type Developer = DeveloperList["developers"][number];

/** One page of a developer's published assets. */
type DeveloperAssetPage = z.infer<typeof developerAssetsSchema>;

/** A developer and every asset they published. */
export type DeveloperAssets = {
  developer: Developer;
  assets: DeveloperAssetPage["assets"];
};

export async function developers(
  search?: string,
  home = homedir(),
): Promise<Developer[]> {
  const conn = await connection(home);
  const people: Developer[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const query: URLSearchParams = new URLSearchParams({
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

    people.push(...page.developers);
    if (page.nextCursor && seen.has(page.nextCursor)) {
      throw new Error("Invalid developer pagination");
    }

    if (page.nextCursor) {
      seen.add(page.nextCursor);
    }

    cursor = page.nextCursor;
  } while (cursor);

  return people;
}

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
  const assets: DeveloperAssets["assets"] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const query: URLSearchParams = new URLSearchParams({
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

    assets.push(...page.assets);
    if (page.nextCursor && seen.has(page.nextCursor)) {
      throw new Error("Invalid discovery pagination");
    }

    if (page.nextCursor) {
      seen.add(page.nextCursor);
    }

    cursor = page.nextCursor;
  } while (cursor);

  return { developer, assets };
}

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

export type PromoteResult =
  | { outcome: "promoted"; promotion: Promotion }
  | { outcome: "moved"; move: MoveResult };

async function copyToScope(
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

/**
 * Proposes an asset for another scope. A local asset has no server copy to
 * propose from, so it is moved there instead and the result is that move.
 */
export async function promote(
  input: PromoteInput,
  home = homedir(),
): Promise<PromoteResult> {
  if (input.origin === LOCAL_ORIGIN) {
    return {
      outcome: "moved",
      move: await moveLocalAssets(
        {
          names: [input.name],
          kind: input.kind,
          to: input.target,
          as: input.newName === input.name ? undefined : input.newName,
        },
        home,
      ),
    };
  }

  return {
    outcome: "promoted",
    promotion: await copyToScope("promote", input, home),
  };
}

/** Copies an asset into a scope the developer owns; a change ID means it needs review. */
export async function fork(
  input: PromoteInput,
  home = homedir(),
): Promise<Promotion> {
  return copyToScope("fork", input, home);
}
