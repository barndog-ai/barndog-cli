import { bad, dim, json, ok, ORIGIN_HELP } from "../ui/format.js";
import { Option, type Command } from "commander";
import { type CommandContext } from "./context.js";
import {
  renderHookCompatibility,
  renderHookMatrix,
} from "../ui/hook-compatibility.js";
import { CliError } from "../errors.js";
import { hookHarnesses } from "../harnesses/registry.js";
import { type HookHarness } from "../harnesses/types.js";
import { defined } from "../shared/lookup.js";
import { positiveInteger } from "../ui/options.js";
import { commandHelpers } from "./helpers.js";

/** Shell timeout utility convention for a timed-out command. */
const TIMEOUT_EXIT_CODE = 124;

function hookTestSummary(timedOut: boolean, exitCode: number) {
  if (timedOut) {
    return `${bad("✖")} Hook test timed out.`;
  }

  if (exitCode) {
    return `${bad("✖")} Hook test exited ${exitCode}.`;
  }

  return `${ok("✔")} Hook test exited 0.`;
}

/** `barndog hooks` commands that test a Hook and report or widen its tool coverage. */
export function registerHooks(program: Command, context: CommandContext) {
  const { write, locate } = commandHelpers(context);

  const hooks = defined(
    program.commands.find((c) => c.name() === "hooks"),
    "Command group hooks isn't registered",
  );

  hooks
    .command("test [name]")
    .option("--origin <origin>", ORIGIN_HELP)
    .addOption(
      new Option("--harness <harness>", "Chosen implementation")
        .choices(hookHarnesses)
        .makeOptionMandatory(),
    )
    .requiredOption("--input <file>", "Native JSON test input")
    .option("--event <event>", "Native event name")
    .option("--handler <number>", "One-based command index", positiveInteger)
    .option("--timeout <seconds>", "Maximum test duration", positiveInteger)
    .description("Explicitly run one published command Hook with test input")
    .action(
      async (
        name: string | undefined,
        options: {
          origin?: string;
          harness: HookHarness;
          input: string;
          event?: string;
          handler?: number;
          timeout?: number;
        },
      ) => {
        const located = await locate(
          "hook",
          name,
          options,
          `barndog hooks test <name> --harness ${options.harness} --input ${options.input}`,
        );

        const test = await context.testHook(located.name, located.origin, {
          harness: options.harness,
          input: options.input,
          event: options.event,
          handler: options.handler,
          timeout: options.timeout,
        });

        // The Hook's own result is the command's result, however it is printed.
        if (test.exitCode || test.timedOut) {
          process.exitCode = test.timedOut ? TIMEOUT_EXIT_CODE : test.exitCode;
        }

        if (context.mode.json) {
          return context.write(json(test));
        }

        if (test.stdout) {
          write(test.stdout.trimEnd());
        }

        if (test.stderr) {
          write(test.stderr.trimEnd());
        }

        write(hookTestSummary(test.timedOut, test.exitCode));
      },
    );

  hooks
    .command("compatibility [name]")
    .option("--origin <origin>", ORIGIN_HELP)
    .option("--all", "Show every selected Hook against each coding tool")
    .description(
      "Inspect version-specific declarations and local runtime requirements",
    )
    .action(
      async (
        name: string | undefined,
        options: { origin?: string; all?: boolean },
      ) => {
        if (options.all) {
          if (name || options.origin) {
            throw new CliError(
              "--all shows every selected Hook, so it takes no name or --origin.",
              "barndog hooks compatibility --all",
            );
          }

          const rows = await context.allHookCompatibility();
          if (context.mode.json) {
            return context.write(json(rows));
          }

          for (const line of renderHookMatrix(rows)) {
            context.write(line);
          }

          return;
        }

        const located = await locate(
          "hook",
          name,
          options,
          "barndog hooks compatibility <name>",
        );

        const result = await context.hookCompatibility(
          located.name,
          located.origin,
        );

        if (context.mode.json) {
          return context.write(json(result));
        }

        for (const line of renderHookCompatibility(located.name, result)) {
          context.write(line);
        }
      },
    );

  hooks
    .command("adapt [name]")
    .option("--origin <origin>", ORIGIN_HELP)
    .addOption(
      new Option(
        "--for <tools...>",
        "Coding tools to adapt it for (default: the ones this machine uses that it doesn't cover)",
      ).choices(hookHarnesses),
    )
    .description(
      "Print a prompt for an AI agent to adapt a Hook to coding tools it wasn't written for",
    )
    .action(
      async (
        name: string | undefined,
        options: { origin?: string; for?: HookHarness[] },
      ) => {
        const located = await locate(
          "hook",
          name,
          options,
          "barndog hooks adapt <name>",
        );

        const result = await context.adaptHook(
          located.name,
          located.origin,
          options.for,
        );

        if (context.mode.json) {
          return context.write(json(result));
        }

        // Printed bare, so it can be piped to the clipboard or an agent.
        context.write(
          result.prompt ??
            dim(
              `${result.name} already has settings for every coding tool this machine uses.`,
            ),
        );
      },
    );
}
