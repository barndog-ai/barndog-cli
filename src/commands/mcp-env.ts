import type { Command } from "commander";

import { barndogPaths } from "../config/paths.js";
import { CliError } from "../errors.js";
import type { KeptValueChange, KeptVariable } from "../features/mcps/values.js";
import { readsFrom, type KeptValue } from "../features/secrets/index.js";
import { bold, dim, hint, json, ok, table, warn } from "../ui/format.js";
import { displayPath, renderSyncOutput } from "../ui/output.js";
import { pickOne } from "../ui/pick.js";
import { askSecret, askUseUnassigned, readStdin } from "../ui/secret-input.js";
import { requireArguments } from "./arguments.js";
import type { CommandContext } from "./context.js";

const SET_USAGE = "barndog mcp env set <server> <variable>";
const UNSET_USAGE = "barndog mcp env unset <server> <variable>";

/** How a kept value reads in a list; never the value itself. */
const describe = (row: KeptVariable) =>
  row.from ? `reads $${row.from}` : "kept";

/**
 * `barndog mcp env`: MCP variable values BarnDog keeps on this machine, each
 * for one MCP server. Every command says where a value is kept and where it
 * was written; none prints one.
 */
export function registerMcpEnv(mcp: Command, context: CommandContext) {
  const env = mcp
    .command("env")
    .description(
      "Keep MCP variable values on this machine, never uploaded, and write them into your coding tools",
    );

  const where = (file: string) => displayPath(file, context.runtime);

  const report = (
    message: string,
    result: KeptValueChange,
    data: { server?: string; variable: string; from?: string },
  ) => {
    const { notWritten } = result;
    if (context.mode.json) {
      return context.write(
        json({
          ...data,
          file: result.file,
          ...(notWritten ? { notWritten } : {}),
        }),
      );
    }

    context.write(`${ok("✔")} ${message}`);
    // Nothing was synced, so there is no sync summary to show.
    if (!notWritten) {
      for (const line of renderSyncOutput(result.events, context.runtime)) {
        context.write(line);
      }
    }

    if (notWritten?.because === "disabled") {
      context.write(
        dim(
          `${data.server ?? "This server"} is disabled, so your coding tools get the change when you enable it.`,
        ),
      );
    }

    if (notWritten?.because === "sync-failed") {
      context.write(
        `${warn("Your coding tools weren't updated:")} ${notWritten.message}`,
      );

      context.write(
        dim(
          `The change is kept; the next ${bold("barndog sync")} writes it into them.`,
        ),
      );

      if (notWritten.fix) {
        context.write(hint(notWritten.fix, "Fix"));
      }
    }
  };

  /** Where a kept value is written, or why it isn't. */
  const writtenInto = (row: KeptVariable) => {
    if (row.writtenTo.length) {
      return row.writtenTo.map(where).join(", ");
    }

    return dim(
      row.enabled === false
        ? "not written (disabled)"
        : "not written anywhere yet",
    );
  };

  env
    .command("set [server] [variable]")
    .description("Keep a value for a variable one MCP server refers to")
    .option("--from <variable>", "Read another environment variable instead")
    .option("--stdin", "Read the value from standard input")
    .addHelpText(
      "after",
      `
The value is saved in ~/.barndog/secrets.json, which only you can read, and never leaves this machine.
Sync then writes it into that server's entry in each coding tool's settings, as the tools store values
they're given; shared definitions keep only the variable's name. A disabled server gets it when you
enable it, and a sync that can't run leaves it for the next one. With --from, the server reads another
variable from your environment instead, such as GITHUB_TOKEN for GITHUB_PERSONAL_ACCESS_TOKEN.`,
    )
    .action(
      async (
        server: string | undefined,
        variable: string | undefined,
        options: { from?: string; stdin?: boolean },
      ) => {
        if (options.from && options.stdin) {
          throw new CliError(
            "Pass either --from or --stdin, not both.",
            SET_USAGE,
          );
        }

        const target = await chooseTarget(server, variable);
        const kept = await valueFor(target, options);
        const file = where(barndogPaths(context.runtime.home).secrets);

        if (kept === "unassigned") {
          return report(
            `${bold(target.server)} now uses the value BarnDog kept for ${bold(target.variable)}, in ${file}.`,
            await context.assignKeptValue(target),
            target,
          );
        }

        const result = await context.keepMcpValue(target, kept);
        const from = readsFrom(kept);
        if (from) {
          return report(
            `${bold(target.server)} reads ${bold(target.variable)} from ${bold(`$${from}`)}. Saved in ${file}.`,
            result,
            { ...target, from },
          );
        }

        report(
          `Saved ${bold(target.variable)} for ${bold(target.server)} in ${file}, readable only by you. It stays on this machine and is never uploaded.`,
          result,
          target,
        );
      },
    );

  env
    .command("unset [server] [variable]")
    .description("Forget a kept value; the server reads the variable again")
    .option(
      "--unassigned",
      "Forget a value kept from before values belonged to servers; name only the variable",
    )
    .action(
      async (
        server: string | undefined,
        variable: string | undefined,
        options: { unassigned?: boolean },
      ) => {
        const kept = await context.listKeptValues();
        const file = where(barndogPaths(context.runtime.home).secrets);

        if (options.unassigned) {
          const named = variable ?? server;
          const name: string =
            named ??
            (
              await pickRow(
                kept.filter((row) => !row.server),
                "Choose a value to forget",
                "barndog mcp env unset --unassigned <variable>",
              )
            ).variable;

          return report(
            `Removed the unassigned value of ${bold(name)} from ${file}.`,
            await context.forgetUnassignedValue(name),
            { variable: name },
          );
        }

        const assigned = kept.filter((row) => row.server !== null);
        const serverRow =
          server === undefined
            ? await pickRow(
                [
                  ...new Map(
                    assigned.map((row) => [row.assetId, row]),
                  ).values(),
                ],
                "Choose an MCP server",
                UNSET_USAGE,
                (row) => row.server ?? "",
              )
            : undefined;

        const target = serverRow?.server ?? server ?? "";
        const ofServer = assigned.filter((row) =>
          [row.server, row.assetId].includes(target),
        );

        const name =
          variable ??
          (ofServer.length === 1 && ofServer[0]
            ? ofServer[0].variable
            : (
                await pickRow(
                  ofServer,
                  `Choose a value of ${target} to forget`,
                  UNSET_USAGE,
                )
              ).variable);

        report(
          `Removed ${bold(name)} for ${bold(target)} from ${file}.`,
          await context.forgetMcpValue({ server: target, variable: name }),
          { server: target, variable: name },
        );
      },
    );

  env
    .command("list")
    .description("List kept values, by MCP server, and where they're written")
    .action(async () => {
      const kept = await context.listKeptValues();
      if (context.mode.json) {
        return context.write(json(kept));
      }

      if (!kept.length) {
        return context.write(
          `${dim("BarnDog keeps no MCP values. Add one with")} ${bold(SET_USAGE)}${dim(".")}`,
        );
      }

      context.write(
        dim(
          `Kept in ${where(barndogPaths(context.runtime.home).secrets)} on this machine only. Values aren't shown.`,
        ),
      );

      for (const line of table(
        kept.map((row) => [
          row.server ? bold(row.server) : dim("not assigned"),
          bold(row.variable),
          describe(row),
          writtenInto(row),
        ]),
        { header: ["Server", "Variable", "Value", "Written into"] },
      )) {
        context.write(line);
      }
    });

  async function pickRow(
    rows: readonly KeptVariable[],
    message: string,
    usage: string,
    name: (row: KeptVariable) => string = (row) => row.variable,
  ): Promise<KeptVariable> {
    requireArguments(context, usage);

    return pickOne(
      message,
      rows.map((row) => ({ value: row, name: name(row) })),
      { empty: "BarnDog keeps no such MCP values." },
    );
  }

  /** The server and variable named, or chosen from lists in a terminal. */
  async function chooseTarget(
    server: string | undefined,
    variable: string | undefined,
  ): Promise<{ server: string; variable: string }> {
    if (server && variable) {
      return { server, variable };
    }

    requireArguments(context, SET_USAGE);
    const servers = await context.recordedMcpServers();

    const item = server
      ? servers.find((candidate) =>
          [candidate.installedName, candidate.name, candidate.id].includes(
            server,
          ),
        )
      : await pickOne(
          "Choose an MCP server",
          servers.map((candidate) => ({
            value: candidate,
            name: candidate.installedName,
            hint: candidate.enabled ? undefined : "disabled",
          })),
          { empty: "No MCP servers on this machine." },
        );

    if (!item) {
      throw new CliError(
        `There's no MCP server called ${server} on this machine.`,
        "barndog mcp list",
      );
    }

    if (variable) {
      return { server: item.installedName, variable };
    }

    const kept = (await context.listKeptValues()).filter(
      (row) => row.assetId === item.id,
    );

    const chosen = await pickOne(
      `Choose a variable of ${item.installedName}`,
      item.variables.map((name) => {
        const row = kept.find((candidate) => candidate.variable === name);

        return { value: name, name, hint: row ? describe(row) : undefined };
      }),
      {
        empty: `BarnDog couldn't find any variables ${item.installedName} uses. Name one: ${SET_USAGE}`,
      },
    );

    return { server: item.installedName, variable: chosen };
  }

  /**
   * The value to keep: another variable to read, standard input, the value a
   * version 1 file kept with no server, or a masked prompt, in that order.
   */
  async function valueFor(
    target: { server: string; variable: string },
    options: { from?: string; stdin?: boolean },
  ): Promise<KeptValue | "unassigned"> {
    if (options.from) {
      return { from: options.from };
    }

    if (options.stdin) {
      return { value: await readStdin() };
    }

    const unassigned = (await context.listKeptValues()).some(
      (row) => !row.server && row.variable === target.variable,
    );

    if (unassigned) {
      if (!context.mode.interactive) {
        return "unassigned";
      }

      if (await askUseUnassigned(target.variable)) {
        return "unassigned";
      }
    }

    if (!context.mode.interactive) {
      throw new CliError(
        "Pass the value on standard input, so it stays out of your shell history.",
        `barndog mcp env set ${target.server} ${target.variable} --stdin`,
      );
    }

    return { value: await askSecret(target.variable) };
  }
}
