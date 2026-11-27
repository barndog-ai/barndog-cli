/** `barndog mcp add`: brings MCP servers from JSON or a coding tool into the local workspace. */
import { localPath } from "../platform.js";
import { CliError } from "../errors.js";
import { only } from "../shared/lookup.js";
import { inputFile } from "../shared/files.js";
import {
  addMcpServers,
  type AddedServers,
  conflictingEntries,
  type ConvertedServer,
  convertServer,
  harnessServers,
  localMcpNamed,
  parseMcpText,
  type ImportedServer,
  type KeptChoice,
  type LiteralValue,
} from "../features/mcps/import.js";
import { assetKinds } from "../features/asset-kinds/index.js";
import { validMcpName } from "../shared/patterns.js";
import { bold, dim, ok, warn } from "./format.js";
import { displayPath, keptValueFiles } from "./output.js";
import { variableProblemLines } from "./variable-problems.js";
import { keptValuesMessage } from "../features/environment/events.js";
import type { RuntimeContext } from "../runtime.js";
import { type AddContext, type AddOptions } from "./add-asset.js";
import { urlQueries } from "../features/asset-kinds/url-query.js";
import {
  LOCAL_URL_QUERY,
  renderMcpValues,
  renderSignIn,
  renderUrlQueries,
} from "./mcp.js";

async function serversToAdd(
  name: string | undefined,
  options: AddOptions,
  context: AddContext,
): Promise<ImportedServer[]> {
  if (options.config) {
    return parseMcpText(options.config, name);
  }

  if (options.file) {
    return parseMcpText(
      (await inputFile(localPath(options.file, context.runtime))).toString(
        "utf8",
      ),
      name,
    );
  }

  const fromHarness = async () => {
    const all = (await harnessServers(context.runtime)).filter(
      (s) => !options.from || s.harness === options.from,
    );

    const matching = name ? all.filter((s) => s.name === name) : all;
    const listed = (servers: typeof all) =>
      servers.map((s) => `${s.name} (${s.label})`).join(", ");

    if (!matching.length) {
      throw new CliError(
        name && all.length
          ? `No MCP server named ${name} in your coding tools. They have ${listed(all)}.`
          : "No MCP servers found in your coding tools that BarnDog doesn't already manage.",
      );
    }

    if (name && matching.length === 1) {
      return matching;
    }

    if (!context.interactive) {
      throw new CliError(
        matching.length === 1
          ? `Name the MCP server to add: ${listed(matching)}.`
          : `Several servers match: ${listed(matching)}.`,
        "barndog mcp add <name> --from <harness>",
      );
    }

    const picked = await context.prompts.chooseMany(
      "Which MCP servers do you want to add?",
      matching.map((s, i) => ({
        name: `${s.name}  ${dim(s.label)}`,
        value: String(i),
      })),
    );

    return picked.flatMap((i) => matching[Number(i)] ?? []);
  };

  if (options.from) {
    return fromHarness();
  }

  if (!context.interactive) {
    if (process.stdin.isTTY) {
      throw new CliError(
        "Pass the configuration with --config, --file or --from, or pipe it in.",
        "barndog mcp add --file <path>",
      );
    }

    let text = "";
    for await (const chunk of process.stdin) {
      text += chunk;
    }

    return parseMcpText(text, name);
  }

  const source = await context.prompts.chooseOne("Where's the configuration?", [
    { name: "Paste JSON", value: "paste" },
    { name: "One of my coding tools", value: "harness" },
  ]);

  return source === "paste"
    ? parseMcpText(await context.prompts.paste(), name)
    : fromHarness();
}

/**
 * Which literal values BarnDog keeps on this machine. Only asked in a
 * terminal; otherwise none are kept and the notes say which variables to set.
 */
async function chooseKept(
  found: { server: string; literal: LiteralValue }[],
  context: AddContext,
): Promise<KeptChoice[]> {
  if (!found.length || !context.interactive) {
    return [];
  }

  context.write(
    dim(
      "BarnDog can keep these values in ~/.barndog/secrets.json, which only you can read and which is never uploaded, and write them into your coding tools' settings. Leave one unticked to set it yourself.",
    ),
  );

  const picked = await context.prompts.chooseMany(
    "Which values should BarnDog keep on this machine?",
    found.map(({ server, literal }, index) => ({
      name: `${literal.variable}  ${dim(`${server}: ${literal.key}`)}`,
      short: literal.variable,
      value: String(index),
      checked: true,
    })),
  );

  return picked.flatMap((index) => {
    const choice = found[Number(index)];

    return choice
      ? [{ server: choice.server, variable: choice.literal.variable }]
      : [];
  });
}

/** Why a server can't be added under `name` here, or null when it can. */
async function nameProblem(name: string, context: AddContext) {
  if (!validMcpName(name)) {
    return `${name} can't be an MCP server name. ${assetKinds.mcp.nameRule}.`;
  }

  const existing = await localMcpNamed(name, context.runtime);
  if (existing === null) {
    return null;
  }

  return existing === name
    ? `You already have a local MCP server named ${name}.`
    : `${name} differs from your local MCP server ${existing} only in case, and they'd share one file on this disk.`;
}

/**
 * Applies `--as`, then asks in a terminal for a new name wherever one is
 * unusable or taken. Without a terminal, adding reports it with the fix.
 */
async function namedServers(
  servers: ImportedServer[],
  as: string | undefined,
  context: AddContext,
): Promise<ImportedServer[]> {
  const one = only(servers);
  if (as !== undefined && !one) {
    throw new CliError(
      "--as renames one MCP server, so add exactly one.",
      "barndog mcp add <name> --as <new-name>",
    );
  }

  const renamed = one && as !== undefined ? [{ ...one, name: as }] : servers;
  if (!context.interactive) {
    return renamed;
  }

  const result: ImportedServer[] = [];
  for (const server of renamed) {
    let name = server.name;
    for (
      let problem = await nameProblem(name, context);
      problem;
      problem = await nameProblem(name, context)
    ) {
      context.write(`${warn("!")} ${problem}`);
      name = (await context.prompts.text(`New name for ${server.name}`)).trim();
    }

    result.push({ ...server, name });
  }

  return result;
}

/**
 * Warns about URLs with a query string, which BarnDog keeps as written, and in
 * a terminal asks whether to add them; elsewhere the added servers' notes say so.
 */
async function confirmUrlQueries(
  servers: readonly ConvertedServer[],
  context: AddContext,
) {
  const queries = urlQueries(servers);
  if (!queries.length || !context.interactive) {
    return;
  }

  for (const line of renderUrlQueries(queries)) {
    context.write(line);
  }

  context.write(dim(LOCAL_URL_QUERY));
  if (
    !(await context.prompts.yes(`Add ${queries.length === 1 ? "it" : "them"}?`))
  ) {
    throw new CliError("Nothing was added.");
  }
}

/**
 * `mcp add`: imports MCP servers from a harness's configuration or pasted JSON
 * into the local workspace.
 */
export async function addMcp(
  name: string | undefined,
  options: AddOptions,
  context: AddContext,
) {
  // `--json` is the global output flag, so this catches the old spelling.
  if (name?.trimStart().startsWith("{")) {
    throw new CliError(
      "That looks like the configuration, not a name.",
      "barndog mcp add <name> --config '<json>'",
    );
  }

  const imported = await namedServers(
    await serversToAdd(name, options, context),
    options.as,
    context,
  );

  const oauth = new Set<string>();
  for (const { name: server, server: raw } of imported) {
    if (
      options.oauth ||
      (context.interactive &&
        (raw.url || raw.httpUrl) &&
        !raw.headers &&
        !raw.http_headers &&
        !raw.env_http_headers &&
        !raw.bearer_token_env_var &&
        (await context.prompts.yes(
          `Does ${server} sign in through a browser (OAuth)?`,
          false,
        )))
    ) {
      oauth.add(server);
    }
  }

  const servers = imported.map((server) =>
    convertServer(server, options.description, oauth.has(server.name)),
  );

  if (!servers.length) {
    throw new CliError("No MCP servers were chosen, so nothing was added.");
  }

  await confirmUrlQueries(servers, context);

  let replace = options.replace;
  const conflicts = (
    await Promise.all(
      servers.map((s) => conflictingEntries(s.name, context.runtime)),
    )
  ).flat();

  if (conflicts.length && !replace && context.interactive) {
    context.write(
      "These entries will be replaced by BarnDog-managed ones. A backup of each file is kept:",
    );

    for (const conflict of conflicts) {
      context.write(dim(`  ${conflict.file}`));
    }

    replace = await context.prompts.yes("Replace them?");
    if (!replace) {
      throw new CliError("Nothing was added.");
    }
  }

  const keep = await chooseKept(
    servers.flatMap((server) =>
      server.literals.map((literal) => ({ server: server.name, literal })),
    ),
    context,
  );

  const result = await addMcpServers(
    servers,
    { replace, keep },
    context.runtime,
  );

  for (const line of renderAddedServers(result, context.runtime)) {
    context.write(line);
  }
}

/** What `mcp add` added, what's left to do, and where it backed up settings. */
function renderAddedServers(
  result: AddedServers,
  runtime: RuntimeContext,
): string[] {
  return [
    ...result.added.map((added) => `${ok("✔")} Added ${bold(added)}`),
    ...result.notes.map(
      (note) => `${warn("!")} ${bold(note.server)}: ${note.text}`,
    ),
    ...renderSignIn(result.signIn, result.events),
    ...renderMcpValues(result.values),
    // Sync says where each kept value was written.
    ...result.events.flatMap((event) => {
      if (event.type === "kept-values") {
        return [
          dim(keptValuesMessage(event)),
          ...keptValueFiles(event, runtime),
        ];
      }

      return event.type === "notice" ? [dim(event.message)] : [];
    }),
    ...result.backups.map((backup) =>
      dim(`Backup: ${displayPath(backup, runtime)}`),
    ),
    // renderMcpValues already lists the literal values left for the developer to set.
    ...variableProblemLines(
      result.events.filter(
        (event) =>
          event.type !== "unset-variable" ||
          !result.values.some(
            (value) =>
              value.server === event.server &&
              value.variable === event.variable,
          ),
      ),
    ),
  ];
}
