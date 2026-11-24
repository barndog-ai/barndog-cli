import { SHORT_COMMIT_LENGTH } from "../shared/constants.js";

import confirm from "@inquirer/confirm";
import { mcpDefinitionSchema } from "@barndog-ai/api-contract";
import { z } from "zod";

import type { McpValue } from "../features/mcps/import.js";
import type {
  ConfirmUrlQuery,
  UrlQuery,
} from "../features/asset-kinds/url-query.js";
import { CliError } from "../errors.js";
import {
  bold,
  clean,
  dim,
  fields,
  hint,
  originLabel,
  renderValue,
  table,
  warn,
} from "./format.js";
import { promptTheme } from "./theme.js";

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

/** One warning per MCP server whose URL has query parameters, naming them but never their values. */
export function renderUrlQueries(servers: readonly UrlQuery[]): string[] {
  return servers.map(
    (server) =>
      `${warn("!")} ${bold(server.name)}'s URL has query parameters: ${server.parameters.join(", ")}.`,
  );
}

/** Said before adding servers with a query string to the local folder. */
export const LOCAL_URL_QUERY =
  "A query string can hold sensitive data, such as an API key. BarnDog keeps the URL as written: it stays on this machine and works as is.";

/** Asks whether to go ahead; tests pass their own answer. */
type AskUrlQuery = (message: string) => Promise<boolean>;

const askToShare: AskUrlQuery = (message) =>
  confirm({ message, default: false, theme: promptTheme });

/**
 * How a command that shares assets beyond this machine asks about MCP servers
 * whose URL has a query string: `--allow-url-query` shares them, a terminal
 * asks (no by default), and anything else is refused with that flag as the fix.
 */
export function confirmSharingUrlQuery(options: {
  interactive: boolean;
  /** `--allow-url-query`: share without asking. */
  allowed?: boolean;
  write: (line: string) => void;
  /** The command line that shares them without asking. */
  fix: string;
  ask?: AskUrlQuery;
}): ConfirmUrlQuery {
  return async (servers) => {
    if (options.allowed) {
      return true;
    }

    const one = servers.length === 1;
    if (!options.interactive) {
      throw new CliError(
        `${servers.map((server) => server.name).join(", ")} ${one ? "has a URL" : "have URLs"} with query parameters, which can hold sensitive data such as an API key, and sharing shows ${one ? "it" : "them"} to everyone who can see the destination.`,
        options.fix,
      );
    }

    for (const line of renderUrlQueries(servers)) {
      options.write(line);
    }

    options.write(
      dim(
        "A query string can hold sensitive data, such as an API key. Sharing keeps the URL as written, so everyone who can see the destination can read it.",
      ),
    );

    return (options.ask ?? askToShare)(`Share ${one ? "it" : "them"} anyway?`);
  };
}
