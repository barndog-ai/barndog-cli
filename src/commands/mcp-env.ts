import type { Command } from "commander";

import { barndogPaths } from "../config/paths.js";
import { CliError } from "../errors.js";
import { bold, dim, json, ok, table } from "../ui/format.js";
import { displayPath, renderSyncOutput } from "../ui/output.js";
import { askSecret, readStdin } from "../ui/secret-input.js";
import type { CommandContext } from "./context.js";

/**
 * `barndog mcp env`: MCP variable values BarnDog keeps on this machine. Every
 * command says where a value is kept and where it was written; none prints one.
 */
export function registerMcpEnv(mcp: Command, context: CommandContext) {
  const env = mcp
    .command("env")
    .description(
      "Keep MCP variable values on this machine, never uploaded, and write them into your coding tools",
    );

  const where = (file: string) => displayPath(file, context.runtime);

  env
    .command("set <variable>")
    .description("Keep a value for a variable MCP servers refer to")
    .option("--stdin", "Read the value from standard input")
    .addHelpText(
      "after",
      `
The value is saved in ~/.barndog/secrets.json, which only you can read, and never leaves this machine.
Sync then writes it into the settings of each coding tool whose MCP servers use the variable, as the
tools store values they're given; shared definitions keep only the variable's name.`,
    )
    .action(async (variable: string, options: { stdin?: boolean }) => {
      const value = await readValue(variable, options.stdin);
      const result = await context.keepMcpValue(variable, value);
      if (context.mode.json) {
        return context.write(json({ variable, file: result.file }));
      }

      context.write(
        `${ok("✔")} Saved ${bold(variable)} in ${where(result.file)}, readable only by you. It stays on this machine and is never uploaded.`,
      );

      for (const line of renderSyncOutput(result.events)) {
        context.write(line);
      }
    });

  env
    .command("unset <variable>")
    .description("Forget a kept value; the tools read the variable again")
    .action(async (variable: string) => {
      const result = await context.forgetMcpValue(variable);
      if (context.mode.json) {
        return context.write(json({ variable, file: result.file }));
      }

      context.write(
        `${ok("✔")} Removed ${bold(variable)} from ${where(result.file)}.`,
      );

      for (const line of renderSyncOutput(result.events)) {
        context.write(line);
      }
    });

  env
    .command("list")
    .description("List kept variables and where their values are written")
    .action(async () => {
      const kept = await context.listKeptValues();
      if (context.mode.json) {
        return context.write(json(kept));
      }

      if (!kept.length) {
        return context.write(
          `${dim("BarnDog keeps no MCP values. Add one with")} ${bold("barndog mcp env set <variable>")}${dim(".")}`,
        );
      }

      context.write(
        dim(
          `Kept in ${where(barndogPaths(context.runtime.home).secrets)} on this machine only. Values aren't shown.`,
        ),
      );

      for (const line of table(
        kept.map((item) => [
          bold(item.variable),
          item.writtenTo.length
            ? item.writtenTo
                .map((place) => `${where(place.file)} (${place.server})`)
                .join(", ")
            : dim("not written anywhere yet"),
        ]),
        { header: ["Variable", "Written into"] },
      )) {
        context.write(line);
      }
    });

  async function readValue(variable: string, stdin: boolean | undefined) {
    if (stdin) {
      return readStdin();
    }

    if (!context.mode.interactive) {
      throw new CliError(
        "Pass the value on standard input, so it stays out of your shell history.",
        `barndog mcp env set ${variable} --stdin`,
      );
    }

    return askSecret(variable);
  }
}
