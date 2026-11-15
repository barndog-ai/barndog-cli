/** `barndog mcp add`: brings MCP servers from JSON or a coding tool into the local workspace. */
import { CliError } from "../errors.js";
import {
  addMcpServers,
  conflictingEntries,
  convertServer,
  harnessServers,
  parseMcpText,
  type ImportedServer,
} from "../features/mcps/import.js";
import { readFile } from "node:fs/promises";
import { bold, dim, ok, warn } from "./format.js";
import { type AddContext, type AddOptions } from "./add-asset.js";

async function serversToAdd(
  name: string | undefined,
  options: AddOptions,
  context: AddContext,
): Promise<ImportedServer[]> {
  if (options.config) {
    return parseMcpText(options.config, name);
  }

  if (options.file) {
    return parseMcpText(await readFile(options.file, "utf8"), name);
  }

  const fromHarness = async () => {
    const all = (await harnessServers(context.home)).filter(
      (s) => !options.from || s.harness === options.from,
    );

    const matching = name ? all.filter((s) => s.name === name) : all;
    if (!matching.length) {
      throw new CliError(
        name
          ? `No MCP server named ${name} in your coding tools.`
          : "No MCP servers found in your coding tools that BarnDog doesn't already manage.",
      );
    }

    if (name && matching.length === 1) {
      return matching;
    }

    if (!context.interactive) {
      throw new CliError(
        `Several servers match: ${matching.map((s) => `${s.name} (${s.label})`).join(", ")}.`,
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

  const imported = await serversToAdd(name, options, context);
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

  let replace = options.replace;
  const conflicts = (
    await Promise.all(
      servers.map((s) => conflictingEntries(s.name, context.home)),
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

  const result = await addMcpServers(servers, { replace }, context.home);
  for (const added of result.added) {
    context.write(`${ok("✔")} Added ${bold(added)}`);
  }

  for (const note of result.notes) {
    context.write(`${warn("!")} ${note}`);
  }

  for (const backup of result.backups) {
    context.write(dim(`Backup: ${backup}`));
  }
}
