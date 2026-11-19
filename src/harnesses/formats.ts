import type { McpDefinition } from "@barndog-ai/api-contract";
import type { KeptValues } from "./types.js";

/** The secret references of a definition: environment for stdio, headers for HTTP. */
export const secretRefs = (definition: McpDefinition) =>
  definition.transport === "stdio"
    ? definition.environment
    : definition.headers;

/**
 * Each environment variable or header of a definition: the kept value when
 * BarnDog keeps one, else the tool's reference to the local variable.
 */
export function valuesOrReferences(
  definition: McpDefinition,
  kept: KeptValues,
  reference: (variable: string) => string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(secretRefs(definition)).map(([name, ref]) => [
      name,
      kept[ref.secretRef] ?? reference(ref.secretRef),
    ]),
  );
}

/**
 * A server entry for a tool that keeps `mcpServers` in JSON, as Claude Code and
 * Cursor do. They differ in how a value refers to a local environment variable
 * and in whether an entry must name its transport in `type`.
 */
export function jsonMcpServer(
  definition: McpDefinition,
  format: { reference: (variable: string) => string; typed: boolean },
  kept: KeptValues,
): Record<string, unknown> {
  const references = valuesOrReferences(definition, kept, format.reference);

  const type = format.typed ? { type: definition.transport } : {};
  const some = Object.keys(references).length > 0;

  if (definition.transport === "http") {
    return {
      ...type,
      url: definition.url,
      ...(some ? { headers: references } : {}),
    };
  }

  return {
    ...type,
    command: definition.command,
    args: definition.args,
    ...(some ? { env: references } : {}),
  };
}

/**
 * A command handler nested under a matcher group, the shape Claude Code and
 * Codex share: `{ matcher, hooks: [{ type: "command", command }] }`.
 */
export const nestedHookEntry = (command: string, matcher?: string) => ({
  ...(matcher ? { matcher } : {}),
  hooks: [{ type: "command", command }],
});

/** The session-start output Claude Code and Codex read added context from. */
export const hookSpecificContext = (text: string) => ({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: text,
  },
});
