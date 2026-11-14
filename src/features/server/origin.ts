import { homedir } from "node:os";
import { z } from "zod";
import {
  contextSchema,
  memberSchema,
  scopeSchema,
} from "@barndog-ai/api-contract";

import type { Connection } from "../../config/settings.js";
import { CliError } from "../../errors.js";
import { only } from "../../shared/lookup.js";
import { splitOrigin } from "../../shared/patterns.js";
import { apiClient } from "../auth/transport.js";

/**
 * Whether an asset or scope belongs to the origin `selector` names: `org`,
 * `me`, `local`, `team/<slug>`, `repo/<slug>`, `dev/<slug>`, or a type with an
 * ID instead of a slug.
 */
export function matchesOrigin(
  origin: { type: string; id: string; slug?: string; localOnly?: boolean },
  selector: string,
  conn: Pick<Connection, "organizationId"> & { developerId?: string },
) {
  if (selector === "local") {
    return origin.localOnly === true;
  }

  if (selector === "org") {
    return origin.type === "org" && origin.id === conn.organizationId;
  }

  if (selector === "me") {
    return origin.type === "dev" && origin.id === conn.developerId;
  }

  const { type, value = "" } = splitOrigin(selector);

  return origin.type === type && [origin.id, origin.slug].includes(value);
}

/**
 * The scope an origin selector names, among those the developer can use.
 * Organization admins can also name any member's personal scope.
 */
export async function selectOrigin(
  selector: string,
  conn: Connection,
  home = homedir(),
) {
  const scopes = z
    .array(scopeSchema)
    .parse((await apiClient(conn.server, home).GET("/v1/scopes")).data);

  const matches = scopes.filter((s) => matchesOrigin(s, selector, conn));
  const personal = splitOrigin(selector);
  if (
    !matches.length &&
    personal.type === "dev" &&
    personal.value !== undefined
  ) {
    const actor = contextSchema.parse(
      (await apiClient(conn.server, home).GET("/v1/context")).data,
    );

    if (actor.developer.role === "organization_admin") {
      const members = z
        .array(memberSchema)
        .parse(
          (await apiClient(conn.server, home).GET("/v1/organization/members"))
            .data,
        );

      for (const member of members) {
        const origin = {
          type: "dev" as const,
          id: member.id,
          slug: member.slug,
          name: member.name,
          canPublish: true,
        };

        if (matchesOrigin(origin, selector, conn)) {
          matches.push(origin);
        }
      }
    }
  }

  const match = only(matches);
  if (!match) {
    throw new CliError(
      `No scope named ${selector} that you can use.`,
      "barndog sets list",
    );
  }

  return match;
}
