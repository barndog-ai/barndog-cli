import { SHORT_COMMIT_LENGTH } from "../shared/constants.js";

import { mcpDefinitionSchema } from "@barndog-ai/api-contract";
import { z } from "zod";

import type { McpValue } from "../features/mcps/import.js";
import {
  bold,
  clean,
  fields,
  hint,
  originLabel,
  renderValue,
  table,
  warn,
} from "./format.js";

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
  /** Variables it refers to that have no value on this machine. */
  unsetVariables: z.array(z.string()).optional(),
});

const signIn = {
  none: "none",
  environment: "environment variables",
  "native-oauth": "OAuth, through each coding tool",
} as const;

/**
 * Where each literal MCP value went: one sentence for the values BarnDog keeps
 * and one for those the developer has to set, each over a column of variables
 * grouped by server.
 */
export function renderMcpValues(values: readonly McpValue[]): string[] {
  const column = (kept: boolean) => {
    const rows: string[][] = [];
    let previous: string | undefined;
    for (const value of values.filter((v) => v.kept === kept)) {
      rows.push([
        value.server === previous ? "" : bold(clean(value.server)),
        clean(value.variable),
      ]);

      previous = value.server;
    }

    return rows;
  };

  const kept = column(true);
  const unset = column(false);
  const output: string[] = [];
  if (kept.length) {
    output.push(
      "",
      "BarnDog keeps these values in ~/.barndog/secrets.json, on this machine only and never uploaded, and writes them into your coding tools:",
      ...table(kept),
    );
  }

  if (unset.length) {
    output.push(
      "",
      `${warn("!")} BarnDog doesn't keep these values. Set each in your environment, or keep it with ${bold("barndog mcp env set <server> <variable>")}:`,
      ...table(unset),
    );
  }

  return output;
}

/**
 * A note per listed MCP server with variables that have no value here. One
 * variable gets the command that sets it; several point at `mcp show`, which
 * gives one for each.
 */
export function unsetVariableNotes(
  items: readonly { installedName: string; unsetVariables?: string[] }[],
): string[] {
  return items.flatMap(({ installedName: name, unsetVariables: variables }) => {
    if (!variables?.length) {
      return [];
    }

    const [only] = variables;
    const fix =
      variables.length === 1 && only
        ? `barndog mcp env set ${clean(name)} ${clean(only)}`
        : `barndog mcp show ${clean(name)}`;

    return [
      "",
      `${warn("!")} ${bold(clean(name))} can't use ${variables.map((variable) => bold(clean(variable))).join(", ")}: no value here.`,
      `  ${hint(fix, "Fix")}`,
    ];
  });
}

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

  const unset = mcp.unsetVariables ?? [];
  const variables = Object.entries(references).map(([key, reference]) => {
    const shown = `${clean(key)} from $${reference.secretRef}`;

    return unset.includes(reference.secretRef)
      ? `${shown} ${warn("(not set)")}`
      : shown;
  });

  const problems = unset.flatMap((variable) => [
    "",
    `${warn("!")} ${bold(clean(variable))} has no value here, so ${clean(mcp.name)} can't use it.`,
    `  ${hint(`barndog mcp env set ${clean(mcp.name)} ${clean(variable)}`, "Fix")}`,
  ]);

  return [
    ...fields([
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
    ]),
    ...problems,
  ];
}
