import { json, ok, ORIGIN_HELP } from "../ui/format.js";
import { Option, type Command } from "commander";
import { type CommandContext } from "./context.js";
import { harnesses } from "../harnesses/registry.js";
import { type Harness } from "../harnesses/types.js";
import { defined } from "../shared/lookup.js";
import { commandHelpers } from "./helpers.js";
import { registerMcpEnv } from "./mcp-env.js";

/** `barndog mcp` commands that publish, inspect and authenticate MCP configurations. */
export function registerMcp(program: Command, context: CommandContext) {
  const { write, print, printMcp, locate } = commandHelpers(context);

  const mcp = defined(
    program.commands.find((c) => c.name() === "mcp"),
    "Command group mcp isn't registered",
  );

  for (const action of ["create", "update"] as const) {
    const command = mcp
      .command(`${action} <name>`)
      .description(
        `${action === "create" ? "Create" : "Publish a new revision of"} an MCP configuration directly`,
      )
      .requiredOption("--origin <origin>", ORIGIN_HELP)
      .requiredOption(
        "--file <file>",
        "JSON connection definition with secret references",
      )
      .option("--key <key>", "Stable key for exact retries");

    if (action === "update") {
      command.requiredOption(
        "--expected-version <id>",
        "Inspected configuration version ID",
      );
    }

    command.action(
      async (
        name: string,
        options: {
          origin: string;
          file: string;
          key?: string;
          expectedVersion: string;
        },
      ) => {
        const result =
          action === "create"
            ? await context.createMcp({ ...options, name })
            : await context.updateMcp({ ...options, name });

        if (context.mode.json) {
          return context.write(json(result));
        }

        write(`${ok("✔")} Published ${name}.`);
        printMcp(result);
      },
    );
  }

  mcp
    .command("show [name]")
    .option("--origin <origin>", ORIGIN_HELP)
    .description("Inspect a connection definition")
    .action(async (name: string | undefined, options: { origin?: string }) => {
      const located = await locate(
        "mcp",
        name,
        options,
        "barndog mcp show <name>",
      );

      const result = await context.showMcp(located.name, located.origin);
      if (context.mode.json) {
        return context.write(json(result));
      }

      printMcp(result);
    });

  mcp
    .command("versions <name>")
    .option("--origin <origin>", ORIGIN_HELP)
    .description("Inspect immutable configuration history")
    .action(async (name: string, options: { origin?: string }) => {
      const located = await locate(
        "mcp",
        name,
        options,
        `barndog mcp versions ${name}`,
      );

      print(await context.mcpVersions(located.name, located.origin));
    });

  mcp
    .command("auth <name>")
    .option("--origin <origin>", ORIGIN_HELP)
    .addOption(
      new Option("--harness <harness>", "Native login owner")
        .choices(harnesses)
        .makeOptionMandatory(),
    )
    .description("Enter native authentication without sharing credentials")
    .action(
      async (name: string, options: { origin?: string; harness: Harness }) => {
        const located = await locate(
          "mcp",
          name,
          options,
          `barndog mcp auth ${name} --harness ${options.harness}`,
        );

        print(
          await context.authenticateMcp(
            located.name,
            located.origin,
            options.harness,
          ),
        );
      },
    );

  registerMcpEnv(mcp, context);
}
