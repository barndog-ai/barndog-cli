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
import { request, selectAsset } from "../environment/remote.js";
import type { AssetKind } from "../asset-selection/types.js";
import { randomUUID } from "node:crypto";

export async function developers(search?: string, home = homedir()) {
  const conn = await connection(home);
  const people: typeof developerListSchema._output.developers = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const query: URLSearchParams = new URLSearchParams({
      limit: "100",
      ...(search ? { search } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const page: typeof developerListSchema._output = await request(
      conn,
      `/v1/developers?${query}`,
      developerListSchema,
      home,
    );
    people.push(...page.developers);
    if (page.nextCursor && seen.has(page.nextCursor))
      throw new Error("Invalid developer pagination");
    if (page.nextCursor) seen.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
  return people;
}

export async function developerAssets(
  selector: string,
  search?: string,
  home = homedir(),
) {
  const people = await developers(undefined, home),
    matches = people.filter((p) => p.id === selector || p.slug === selector);
  if (matches.length !== 1)
    throw new CliError(
      `No developer found with that handle.`,
      "barndog people list",
    );
  const conn = await connection(home);
  const assets: typeof developerAssetsSchema._output.assets = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const query: URLSearchParams = new URLSearchParams({
      limit: "100",
      ...(search ? { search } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const page: typeof developerAssetsSchema._output = await request(
      conn,
      `/v1/developers/${matches[0]!.id}/assets?${query}`,
      developerAssetsSchema,
      home,
    );
    assets.push(...page.assets);
    if (page.nextCursor && seen.has(page.nextCursor))
      throw new Error("Invalid discovery pagination");
    if (page.nextCursor) seen.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
  return { developer: matches[0]!, assets };
}

export async function promote(
  kind: AssetKind,
  name: string,
  origin: string,
  target: string,
  newName: string,
  home = homedir(),
  fork = false,
  key: string = randomUUID(),
) {
  const selected = await selectAsset(kind, name, origin, home),
    scope = await selectOrigin(target, selected.connection, home);
  const schema = fork ? forkInputSchema : promotionInputSchema;
  const body = schema.parse({
    name: newName,
    origin: { type: scope.type, id: scope.id },
    idempotencyKey: key,
  });
  return request(
    selected.connection,
    `/v1/environment/${kind}/${selected.reference.id}/${fork ? "fork" : "promote"}`,
    z.object({
      kind: z.enum(["skill", "hook", "mcp"]),
      id: z.uuid(),
      changeId: z.uuid().optional(),
    }),
    home,
    "POST",
    body,
  );
}
