import type { Command } from "commander";
import { resolve } from "node:path";
import type { CommandContext } from "./context.js";
import { renderSyncOutput } from "../ui/output.js";
import { json } from "../ui/format.js";
import { autoSync } from "../features/environment/auto-sync.js";

export function registerSync(program: Command, context: CommandContext): void {
  program
    .command("sync")
    .description(
      "Apply your selection to every coding tool: install, update and remove Skills, MCP servers, Hooks and knowledge",
    )
    .option("--dry-run", "Show what would change without changing anything")
    .option(
      "-v, --verbose",
      "Also list what is already up to date, including BarnDog's own entries",
    )
    .option("--config <path>", "Use an explicit configuration file once")
    .option("--auto", "Quiet background sync used at session start")
    .action(
      async (options: {
        config?: string;
        dryRun?: boolean;
        verbose?: boolean;
        auto?: boolean;
      }) => {
        // Runs detached at session start: nobody is watching, so it never reports.
        if (options.auto) {
          await autoSync(() =>
            context.synchronize(undefined, { refresh: "auto", prompt: false }),
          ).catch(() => undefined);
          return;
        }
        const configPath =
          options.config === undefined ? undefined : resolve(options.config);
        const events = await context.synchronize(
          configPath,
          options.dryRun ? { dryRun: true } : undefined,
        );
        if (context.mode.json) return context.write(json(events));
        for (const line of renderSyncOutput(events, {
          title: options.dryRun ? "sync --dry-run" : "sync",
          preview: options.dryRun,
          verbose: options.verbose,
        }))
          context.write(line);
      },
    );
}
