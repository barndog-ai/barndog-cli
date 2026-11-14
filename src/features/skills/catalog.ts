import {
  contextSchema,
  listOutputSchema,
  type Skill,
} from "@barndog-ai/api-contract";
import { homedir } from "node:os";
import type { Connection } from "../../config/settings.js";
import { apiClient } from "../auth/transport.js";
import type { CatalogAsset } from "../catalog/index.js";

/**
 * Every published Skill the developer can see, page by page. Throws when the
 * server now reports another organization or developer than `connection`, or
 * answers with a broken page.
 */
export async function publishedSkills(
  connection: Connection,
  home = homedir(),
): Promise<Skill[]> {
  const client = apiClient(connection.server, home);
  const context = contextSchema.parse((await client.GET("/v1/context")).data);
  if (
    context.organization.id !== connection.organizationId ||
    context.developer.id !== connection.developerId
  ) {
    throw new Error(
      "Server organization or developer changed; run initialization again",
    );
  }

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
    ) {
      throw new Error("Invalid catalog organization");
    }

    skills.push(...page.skills);
    if (page.nextCursor && cursors.has(page.nextCursor)) {
      throw new Error("Invalid catalog pagination");
    }

    if (page.nextCursor) {
      cursors.add(page.nextCursor);
    }

    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  if (new Set(skills.map((skill) => skill.id)).size !== skills.length) {
    throw new Error("Duplicate catalog Skill");
  }

  return skills;
}

export async function skillCatalog(
  connection: Connection,
  home: string,
): Promise<CatalogAsset[]> {
  return (await publishedSkills(connection, home)).map((skill) => ({
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
