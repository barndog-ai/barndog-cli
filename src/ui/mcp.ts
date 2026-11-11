import type { McpDefinition } from "@barndog-ai/api-contract";

import { clean, fields, originLabel, renderValue } from "./format.js";

type ShownMcp = {
  name: string;
  origin: string | { type: string; slug?: string; id: string };
  /** Cloud nests the definition in a numbered version; repos give a content hash. */
  version: string | { number: number; definition: McpDefinition };
  definition?: McpDefinition;
};

const signIn = {
  none: "none",
  environment: "environment variables",
  "native-oauth": "OAuth, through each coding tool",
} as const;

/** An MCP configuration as a person reads it; secret references print by name. */
export function renderMcp(value: unknown): string[] {
  const mcp = value as ShownMcp;
  const definition =
    mcp.definition ??
    (typeof mcp.version === "object" ? mcp.version.definition : undefined);
  if (!definition) return renderValue(value);
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
        : mcp.version.slice(0, 7),
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
