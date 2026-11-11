import type { Command } from "commander";
import type { CommandContext } from "./context.js";

export function registerInit(program: Command, context: CommandContext): void {
  program
    .command("init")
    .description(
      "Set up this machine: connect, choose coding tools and shared assets",
    )
    .option("--server <url>", "Connect to a BarnDog server")
    .option("--local", "Keep assets in a folder on this machine")
    .option("--repo <url>", "Share assets through one Git repository")
    .option("--no-browser", "Display the sign-in URL without opening it")
    .action(
      async (options: {
        server?: string;
        local?: boolean;
        repo?: string;
        browser: boolean;
      }) => {
        if (options.local && options.server)
          program.error("--local cannot be combined with --server");
        if (options.repo && (options.local || options.server))
          program.error("--repo cannot be combined with --local or --server");
        await context.setup(true, options.server, {
          local: options.local,
          browser: options.browser,
          ...(options.repo ? { repo: options.repo } : {}),
        });
      },
    );
}
