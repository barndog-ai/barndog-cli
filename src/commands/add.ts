import { Option, type Command } from "commander";
import { stripVTControlCharacters } from "node:util";

import type { UpdateMode } from "../features/imports/local.js";
import {
  addHook,
  addMcp,
  addSkills,
  terminalPrompts,
  type AddContext,
  type AddOptions,
} from "../ui/add-asset.js";
import { renderCollaboration } from "../ui/collaboration.js";
import { dim, json, ok } from "../ui/format.js";
import { renderSyncOutput } from "../ui/output.js";
import type { CommandContext } from "./context.js";

const updates = () =>
  new Option("--updates <mode>", "Stay current: fork, manual or auto").choices([
    "fork",
    "manual",
    "auto",
  ] satisfies UpdateMode[]);

export function registerAdd(program: Command, context: CommandContext) {
  const group = (name: string) =>
    program.commands.find((c) => c.name() === name)!;
  const add = () => ({
    interactive: context.mode.interactive,
    write: context.write,
    prompts: terminalPrompts(context.write),
  });
  /** Adding narrates as it goes; `--json` callers get those lines as one object. */
  const reporting = async (run: (add: AddContext) => Promise<void>) => {
    if (!context.mode.json) return run(add());
    const messages: string[] = [];
    await run({
      ...add(),
      write: (line) => messages.push(stripVTControlCharacters(line)),
    });
    context.write(json({ messages }));
  };
  group("skills")
    .command("add <source>")
    .description("Add Skills from a folder, GitHub or Git repository")
    .addOption(updates())
    .addOption(
      new Option(
        "--copy",
        "From a folder: leave the original in place",
      ).conflicts("move"),
    )
    .option("--move", "From a folder: remove the original once it's added")
    .option("--as <name>", "Add one Skill under a different name")
    .option("--only <names...>", "Choose Skills by name or folder")
    .option("--all", "Add every Skill in the repository")
    .action((url: string, options: AddOptions) =>
      reporting((context) => addSkills(url, options, context)),
    );
  group("hooks")
    .command("add <url>")
    .description(
      "Add a Hook from a repository, for the coding tools it was written for",
    )
    .addOption(updates())
    .option("--as <name>", "Add it under a different name")
    .option("--only <names...>", "Choose a Hook by name")
    .option("--description <text>", "What the Hook does")
    .action((url: string, options: AddOptions) =>
      reporting((context) => addHook(url, options, context)),
    );
  group("mcp")
    .command("add [name]")
    .description("Add an MCP server from JSON or from one of your coding tools")
    .option("--config <json>", "Server configuration as JSON text")
    .option("--file <path>", "Read the configuration from a file")
    .addOption(
      new Option("--from <harness>", "Import from a coding tool").choices([
        "claude",
        "codex",
        "cursor",
      ]),
    )
    .option("--replace", "Replace an existing entry in your coding tools")
    .option("--oauth", "The server signs in through your coding tool (OAuth)")
    .option("--description <text>", "What the server does")
    .action((name: string | undefined, options: AddOptions) =>
      reporting((context) => addMcp(name, options, context)),
    );
  for (const [name, kind] of [
    ["skills", "skill"],
    ["hooks", "hook"],
  ] as const)
    group(name)
      .command("update [name]")
      .description(
        "Bring assets added from a repository up to date, showing what changed",
      )
      .option("--force", "Overwrite local edits")
      .option("--dry-run", "Show what would change without changing anything")
      .action(
        async (
          asset: string | undefined,
          options: { force?: boolean; dryRun?: boolean },
        ) => {
          const results = await context.updateImported(kind, asset, {
            force: options.force,
            dryRun: options.dryRun,
          });
          // New files only reach coding tools through the installed copies.
          const applied =
            !options.dryRun && results.some((r) => r.changes.length > 0);
          const events = applied
            ? await context.synchronize(undefined, { prompt: false })
            : [];
          if (context.mode.json) return context.write(json(results));
          if (!results.length)
            return context.write(dim("Nothing was added from a repository."));
          for (const result of results) {
            context.write(
              `${result.name}: ${result.changes.length ? `${result.changes.length} file${result.changes.length === 1 ? "" : "s"} changed` : "up to date"}`,
            );
            if (result.changes.length)
              for (const line of renderCollaboration("diff", result.changes))
                context.write(line);
          }
          if (applied) {
            for (const line of renderSyncOutput(events)) context.write(line);
            context.write(`${ok("✔")} Update installed.`);
          }
        },
      );
}
