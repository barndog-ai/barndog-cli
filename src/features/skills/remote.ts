import { normalizeServer, serverFetch } from "../auth/transport.js";
import {
  contextSchema,
  listOutputSchema,
  createApiClient,
  type Skill,
} from "@barndog-ai/api-contract";
import { homedir } from "node:os";
import { type Connection } from "../../config/settings.js";
import type { CatalogAsset } from "../catalog/index.js";

export { normalizeServer } from "../auth/transport.js";

export function apiClient(server: string, home = homedir()) {
  return createApiClient({
    baseUrl: normalizeServer(server),
    fetch: serverFetch(server, home),
  });
}

export async function connectionContext(
  server: string,
  home = homedir(),
): Promise<Connection> {
  server = normalizeServer(server);
  const context = contextSchema.parse(
    (await apiClient(server, home).GET("/v1/context")).data,
  );
  return {
    server,
    organizationId: context.organization.id,
    developerId: context.developer.id,
  };
}

export async function catalog(
  connection: Connection,
  home = homedir(),
): Promise<Skill[]> {
  const client = apiClient(connection.server, home);
  const context = contextSchema.parse((await client.GET("/v1/context")).data);
  if (
    context.organization.id !== connection.organizationId ||
    context.developer.id !== connection.developerId
  )
    throw new Error(
      "Server organization or developer changed; run initialization again",
    );
  const skills: Skill[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = listOutputSchema.parse(
      (
        await client.GET("/v1/skills", {
          params: { query: { cursor, limit: 100 } },
        })
      ).data,
    );
    if (
      page.skills.some(
        (skill) => skill.organizationId !== connection.organizationId,
      )
    )
      throw new Error("Invalid catalog organization");
    skills.push(...page.skills);
    if (page.nextCursor && cursors.has(page.nextCursor))
      throw new Error("Invalid catalog pagination");
    if (page.nextCursor) cursors.add(page.nextCursor);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  if (new Set(skills.map((skill) => skill.id)).size !== skills.length)
    throw new Error("Duplicate catalog Skill");
  return skills;
}

export async function skillCatalog(
  connection: Connection,
  home: string,
): Promise<CatalogAsset[]> {
  return (await catalog(connection, home)).map((skill) => ({
    id: skill.id,
    kind: "skill",
    name: skill.name,
    origin: skill.origin,
    version: {
      number: skill.version.number,
      description: skill.version.description,
    },
  }));
}
