import { SHORT_COMMIT_LENGTH } from "../shared/constants.js";

import { mcpDefinitionSchema } from "@barndog-ai/api-contract";
import { z } from "zod";

import { clean, fields, originLabel, renderValue } from "./format.js";

const shownMcpSchema = z.looseObject({
  name: z.string(),
  origin: z.union([
    z.string(),
    z.looseObject({
      type: z.string(),
      slug: z.string().optional(),
      id: z.string(),
    }),
  ]),
  /** Cloud nests the definition in a numbered version; repos give a content hash. */
  version: z.union([
    z.string(),
    z.looseObject({ number: z.number(), definition: mcpDefinitionSchema }),
  ]),
  definition: mcpDefinitionSchema.optional(),
});

const signIn = {
  none: "none",
  environment: "environment variables",
  "native-oauth": "OAuth, through each coding tool",
} as const;

/** An MCP configuration as a person reads it; secret references print by name. */
export function renderMcp(value: unknown): string[] {
  const shown = shownMcpSchema.safeParse(value);
  if (!shown.success) {
    return renderValue(value);
  }

  const mcp = shown.data;
  const definition =
    mcp.definition ??
    (typeof mcp.version === "object" ? mcp.version.definition : undefined);

  if (!definition) {
    return renderValue(value);
  }

  const references =
    definition.transport === "stdio"
      ? definition.environment
      : definition.headers;

  const variables = Object.entries(references).map(
    ([key, reference]) => `${clean(key)} from $${reference.secretRef}`,
  );

  return fields([
    ["Name", clean(mcp.name)],
    [
      "Origin",
      typeof mcp.origin === "string" ? mcp.origin : originLabel(mcp.origin),
    ],
    [
      "Version",
      typeof mcp.version === "object"
        ? `v${mcp.version.number}`
        : mcp.version.slice(0, SHORT_COMMIT_LENGTH),
    ],
    ["Description", clean(definition.description)],
    [
      "Connects to",
      definition.transport === "http"
        ? clean(definition.url)
        : clean([definition.command, ...definition.args].join(" ")),
    ],
    ["Sign-in", signIn[definition.authentication]],
    ["Variables", variables.join(", ")],
  ]);
}
