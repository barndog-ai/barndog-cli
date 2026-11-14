import type { Command } from "commander";
import type { CommandContext } from "./context.js";

/**
 * Registers login, logout and session-status handlers on the supplied Commander
 * program.
 */
export function registerAuth(program: Command, context: CommandContext) {
  program
    .command("login")
    .description("Sign in to your BarnDog workspace in the browser")
    .option(
      "--server <url>",
      "Workspace URL, such as https://barndog.example.com",
    )
    .option("--no-browser", "Print the sign-in URL instead of opening it")
    .option("--force", "Sign in again even if you're already signed in")
    .action(
      async (options: {
        server?: string;
        browser: boolean;
        force?: boolean;
      }) => {
        await context.login(options);
      },
    );

  program
    .command("logout")
    .description("Sign out and revoke this machine's session")
    .action(async () => {
      await context.logout();
    });

  program
    .command("auth")
    .description("Check your sign-in")
    .command("status", { isDefault: true })
    .description("Show who you're signed in as, your organization and role")
    .action(async () => {
      await context.authStatus();
    });
}
