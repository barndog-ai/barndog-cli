import { openBrowser } from "../ui/auth.js";
import {
  bad,
  bold,
  dim,
  fields,
  heading,
  hint,
  json,
  ok,
  warn,
} from "../ui/format.js";
import { type Command } from "commander";
import { type CommandContext } from "./context.js";
import { registerMcp } from "./mcp.js";
import { registerHooks } from "./hooks.js";
import { registerKnowledge } from "./knowledge.js";
import { registerPeople } from "./people.js";
import { registerGithub } from "./github.js";

const checkMarks: Record<"ok" | "warn" | "fail", string> = {
  ok: ok("✔"),
  warn: warn("!"),
  fail: bad("✖"),
};

function repositoryLabel(
  repository: { name: string; slug: string } | null | undefined,
  ambiguous: boolean | undefined,
) {
  if (repository) {
    return `${bold(repository.name)} ${dim(`repo/${repository.slug}`)}`;
  }

  if (ambiguous) {
    return warn("matches several BarnDog repositories");
  }

  return dim("not registered in BarnDog");
}

function yesNo(value: boolean) {
  return value ? ok("yes") : "no";
}

function doctorSummary(failed: number, warned: number) {
  if (failed) {
    return `${bad("✖")} ${failed} ${failed === 1 ? "problem" : "problems"} found.`;
  }

  if (warned) {
    return `${warn("!")} ${warned} ${warned === 1 ? "warning" : "warnings"}.`;
  }

  return `${ok("✔")} Everything looks good.`;
}

/** `whoami`, `open`, `repo status` and `doctor`. */
function registerGeneral(program: Command, context: CommandContext) {
  program
    .command("whoami")
    .description("Show who you're signed in as (same as auth status)")
    .action(() => context.authStatus());

  program
    .command("open")
    .description("Open your BarnDog workspace in a browser")
    .option("--no-browser", "Print the URL without opening it")
    .action(async (options: { browser: boolean }) => {
      const url = await context.workspaceUrl();
      if (context.mode.json) {
        return context.write(json({ url }));
      }

      if (!options.browser) {
        return context.write(url);
      }

      try {
        await openBrowser(url);
        context.write(`${ok("✔")} Opened ${bold(url)} in your browser.`);
      } catch {
        context.write(`Couldn't open a browser. Visit ${bold(url)}`);
      }
    });

  program
    .command("repo")
    .description("See how the current Git repository maps to BarnDog")
    .command("status", { isDefault: true })
    .description(
      "Show the repository, its owning team and whether you're subscribed",
    )
    .action(async () => {
      const result = await context.repoStatus();
      // A failed lookup is reported, never shown as "Subscribed: no".
      const sets = result.repository ? await context.listSets() : undefined;

      if (context.mode.json) {
        return context.write(json(result));
      }

      if (!result.root) {
        context.write("Not inside a Git repository.");
        context.write(
          `${dim("Tip:")} run ${bold("barndog repo status")} from inside your repository.`,
        );

        return;
      }

      const repositoryId = result.repository?.id;
      const subscribed =
        repositoryId &&
        sets?.subscriptions.some(
          (s) => s.scope.type === "repo" && s.scope.id === repositoryId,
        );

      for (const line of fields([
        ["Folder", result.root],
        ["Remotes", result.remotes.join(", ") || dim("none")],
        ["Repository", repositoryLabel(result.repository, result.ambiguous)],
        [
          "Owning team",
          result.team
            ? `${result.team.name} ${dim(`team/${result.team.slug}`)}`
            : undefined,
        ],
        [
          "Subscribed",
          result.repository ? yesNo(Boolean(subscribed)) : undefined,
        ],
      ])) {
        context.write(line);
      }

      if (result.repository && !subscribed) {
        context.write("");
        context.write(
          hint(`barndog sets install repo/${result.repository.slug}`) +
            dim("  to use this repository's shared assets"),
        );
      }

      if (!result.repository && !result.ambiguous) {
        context.write("");
        context.write(
          dim(
            "An admin can register this repository in the BarnDog workspace.",
          ),
        );
      }
    });

  program
    .command("doctor")
    .description(
      "Check your setup, session and installed assets, and suggest fixes",
    )
    .action(async () => {
      const checks = await context.doctor();
      if (context.mode.json) {
        return context.write(json(checks));
      }

      context.write(`\n${heading("doctor")}\n`);
      const width = Math.max(...checks.map((c) => c.name.length));
      for (const check of checks) {
        const mark = checkMarks[check.status];

        context.write(
          `${mark} ${check.name.padEnd(width)}  ${check.status === "ok" ? dim(check.detail) : check.detail}`,
        );

        if (check.fix) {
          // A fix in words reads as plain text when a command follows it.
          context.write(
            check.command
              ? `  ${" ".repeat(width)}  ${dim("Fix:")} ${check.fix}`
              : `  ${" ".repeat(width)}  ${hint(check.fix, "Fix")}`,
          );
        }

        if (check.command) {
          context.write(
            `  ${" ".repeat(width)}  ${dim("Command:")} ${bold(check.command)}`,
          );
        }
      }

      const failed = checks.filter((c) => c.status === "fail").length;
      const warned = checks.filter((c) => c.status === "warn").length;
      context.write("");
      context.write(doctorSummary(failed, warned));

      if (failed) {
        process.exitCode = 1;
      }
    });
}

/**
 * Registers the diagnostic commands and the `mcp`, `hooks`, `knowledge`, `people`
 * and `github` groups.
 */
export function registerCapabilities(
  program: Command,
  context: CommandContext,
) {
  registerGeneral(program, context);
  registerMcp(program, context);
  registerHooks(program, context);
  registerKnowledge(program, context);
  registerPeople(program, context);
  registerGithub(program, context);
}
