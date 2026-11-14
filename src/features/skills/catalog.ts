import {
  contextSchema,
  listOutputSchema,
  type Skill,
} from "@barndog-ai/api-contract";
import { homedir } from "node:os";
import type { Connection } from "../../config/settings.js";
import { apiClient } from "../auth/transport.js";
import type { CatalogAsset } from "../asset-kinds/index.js";
import { CliError } from "../../errors.js";
import { allPages } from "../server/pages.js";

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
    throw new CliError(
      "The server's organization or developer changed since this machine was set up.",
      "barndog init",
    );
  }

  const skills = await allPages(async (cursor) => {
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
      throw new Error(
        "The server sent a catalog page for another organization",
      );
    }

    return { items: page.skills, nextCursor: page.nextCursor };
  });

  if (new Set(skills.map((skill) => skill.id)).size !== skills.length) {
    throw new Error("The server sent the same Skill twice in its catalog");
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
