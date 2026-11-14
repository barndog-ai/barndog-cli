import { openBrowser } from "../ui/auth.js";
import { safe } from "../ui/collaboration.js";
import { renderMcp } from "../ui/mcp.js";
import { runSelection } from "../ui/selection.js";
import {
  bad,
  bold,
  clean,
  dim,
  fields,
  heading,
  hint,
  json,
  ok,
  originLabel,
  renderValue,
  table,
  warn,
} from "../ui/format.js";

import { Option, type Command } from "commander";
import { ORIGIN_HELP } from "../ui/format.js";
import type { CommandContext } from "./context.js";
import { pickInstalled, resolveOrigin } from "./origin.js";
import { renderHookCompatibility } from "../ui/hook-compatibility.js";
import type { AssetKind } from "../features/asset-selection/types.js";
import type {
  GithubConnectOptions,
  GithubCreateRepositoryOptions,
  GithubRepositoryOptions,
  GithubResolveMirrorOptions,
} from "../features/github/connections.js";
import type {
  GithubPullsCommentOptions,
  GithubPullsCreateOptions,
  GithubPullsReviewOptions,
  GithubPullsReviseOptions,
} from "../features/github/pulls.js";
import type { Harness } from "../harnesses/types.js";
import { packageKindList } from "../features/asset-kinds/index.js";
import { defined } from "../shared/lookup.js";
import { positiveInteger } from "../ui/options.js";

/** Shell timeout utility convention for a timed-out command. */
const TIMEOUT_EXIT_CODE = 124;

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

function hookTestSummary(timedOut: boolean, exitCode: number) {
  if (timedOut) {
    return `${bad("✖")} Hook test timed out.`;
  }

  if (exitCode) {
    return `${bad("✖")} Hook test exited ${exitCode}.`;
  }

  return `${ok("✔")} Hook test exited 0.`;
}

/** When coding tools see a knowledge document. */
function knowledgeListing(listedAtStart: boolean, accessMode: string) {
  if (listedAtStart) {
    return ok("every session");
  }

  return accessMode === "always" ? dim("off") : dim("on demand");
}

/**
 * Registers catalog, asset, diagnostic and GitHub commands using the supplied
 * services and output mode.
 */
export function registerCapabilities(
  program: Command,
  context: CommandContext,
) {
  const write = (value: string) => context.write(safe(value));
  const print = (result: unknown) => {
    if (context.mode.json) {
      context.write(json(result));
    } else if (typeof result === "object" && result && "message" in result) {
      write(String(result.message));
    } else {
      for (const line of renderValue(result)) {
        context.write(line);
      }
    }
  };

  const printMcp = (result: unknown) => {
    for (const line of renderMcp(result)) {
      context.write(line);
    }
  };

  /** Adds the owning scope, asking only when several scopes share the name. */
  const locate = async <T extends { origin?: string }>(
    kind: AssetKind,
    name: string | undefined,
    options: T,
    usage: string,
  ) =>
    name
      ? {
          ...options,
          name,
          origin: await resolveOrigin(context, {
            kind,
            name,
            origin: options.origin,
            usage: usage.replace("<name>", name),
          }),
        }
      : { ...options, ...(await pickInstalled(context, kind, usage)) };

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
      const sets = result.repository
        ? await context.listSets().catch(() => undefined)
        : undefined;

      if (context.mode.json) {
        return context.write(json(result));
      }

      if (!result.root) {
        context.write("Not inside a Git repository.");
        context.write(
          hint("cd <your-repository> && barndog repo status", "Tip"),
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
          context.write(`  ${" ".repeat(width)}  ${hint(check.fix, "Fix")}`);
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
    .command("show <name>")
    .option("--origin <origin>", ORIGIN_HELP)
    .description("Inspect a connection definition")
    .action(async (name: string, options: { origin?: string }) => {
      const located = await locate(
        "mcp",
        name,
        options,
        `barndog mcp show ${name}`,
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
        .choices(["claude", "codex", "cursor"])
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

  const hooks = defined(
    program.commands.find((c) => c.name() === "hooks"),
    "Command group hooks isn't registered",
  );

  hooks
    .command("test [name]")
    .option("--origin <origin>", ORIGIN_HELP)
    .addOption(
      new Option("--harness <harness>", "Chosen implementation")
        .choices(["claude", "codex", "cursor"])
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
          harness: Harness;
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
    .description(
      "Inspect version-specific declarations and local runtime requirements",
    )
    .action(async (name: string | undefined, options: { origin?: string }) => {
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
    });

  hooks
    .command("adapt [name]")
    .option("--origin <origin>", ORIGIN_HELP)
    .addOption(
      new Option(
        "--for <tools...>",
        "Coding tools to adapt it for (default: the ones this machine uses that it doesn't cover)",
      ).choices(["claude", "codex", "cursor"]),
    )
    .description(
      "Print a prompt for an AI agent to adapt a Hook to coding tools it wasn't written for",
    )
    .action(
      async (
        name: string | undefined,
        options: { origin?: string; for?: Harness[] },
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

  const knowledge = program
    .command("knowledge")
    .description("Read your organization's shared knowledge documents");

  knowledge
    .command("list")
    .description("List knowledge documents and when coding tools see them")
    .option("--always", "Only documents listed at every session start")
    .action(async (options: { always?: boolean }) => {
      const docs = await context.knowledgeList(options.always);
      if (context.mode.json) {
        return context.write(json(docs));
      }

      const problems = await context.knowledgeProblems().catch(() => []);
      for (const problem of problems) {
        context.write(`${warn("!")} ${problem.path}: ${problem.reason}`);
      }

      if (!docs.length) {
        return context.write(dim("No knowledge documents yet."));
      }

      for (const line of table(
        docs.map((doc) => [
          bold(clean(doc.name)),
          knowledgeListing(doc.listedAtStart, doc.accessMode),
          dim(clean(doc.description)),
        ]),
        { header: ["Name", "Listed", "Description"] },
      )) {
        context.write(line);
      }

      context.write("");
      if (docs.some((d) => d.accessMode === "always" && !d.listedAtStart)) {
        context.write(
          hint("barndog knowledge enable", "Tip") +
            dim("  to list these at session start again"),
        );
      }

      context.write(
        hint("barndog knowledge get <name>", "Tip") + dim("  to read one"),
      );
    });

  knowledge
    .command("get <name>")
    .description("Print a knowledge document")
    .action(async (name: string) => {
      const result = await context.knowledgeGet(name);
      if (context.mode.json) {
        return context.write(json(result));
      }

      write(result.version.content.markdown);
    });

  for (const action of ["enable", "disable"] as const) {
    knowledge
      .command(action)
      .description(
        action === "enable"
          ? "Tell coding tools at session start which knowledge documents exist"
          : "Stop listing knowledge documents at session start",
      )
      .action(async () => {
        await runSelection(context, () =>
          context.setKnowledge(action === "enable"),
        );

        if (context.mode.json) {
          return;
        }

        context.write(
          action === "enable"
            ? `${ok("✔")} Coding tools now see the list of knowledge documents when a session starts.`
            : `${ok("✔")} Knowledge documents are no longer listed at session start.`,
        );
      });
  }

  const people = program
    .command("people")
    .description("Find coworkers and the personal assets they share");

  people
    .command("list")
    .description("List people in your organization")
    .option("--search <query>", "Search names or handles")
    .action(async (options: { search?: string }) => {
      const rows = await context.developers(options.search);
      if (context.mode.json) {
        return context.write(json(rows));
      }

      if (!rows.length) {
        return context.write(dim("No matching people."));
      }

      for (const line of table(
        rows.map((person) => [
          bold(clean(person.name)),
          dim(`@${clean(person.slug)}`),
        ]),
        { header: ["Name", "Handle"] },
      )) {
        context.write(line);
      }

      context.write("");
      context.write(
        hint("barndog people show <handle>", "Tip") +
          dim("  to see what someone shares"),
      );
    });

  people
    .command("show <handle>")
    .description("List a person's shared assets")
    .option("--search <query>", "Filter asset names")
    .action(async (handle: string, options: { search?: string }) => {
      const result = await context.developerAssets(handle, options.search);
      if (context.mode.json) {
        return context.write(json(result));
      }

      context.write(
        `${bold(clean(result.developer.name))} ${dim(`@${result.developer.slug}`)}`,
      );

      context.write("");
      if (!result.assets.length) {
        return context.write(dim("  Nothing shared yet."));
      }

      for (const line of table(
        result.assets.map((asset) => [
          dim(asset.kind),
          bold(clean(asset.name)),
          originLabel(asset.origin),
        ]),
        { header: ["Kind", "Name", "Origin"] },
      )) {
        context.write(line);
      }
    });

  const github = program
    .command("github")
    .description("Manage GitHub App connections, contributions and mirrors");

  for (const [name, step, page] of [
    ["auth", "authorization", context.githubAuth],
    ["install", "App installation", context.githubInstall],
  ] as const) {
    github
      .command(name)
      .option("--no-browser", "Print the URL without opening it")
      .action(async (options: { browser: boolean }) => {
        const { url } = await page();
        if (options.browser) {
          // The message below still gives the URL when no browser opens.
          await openBrowser(url).catch(() => undefined);
        }

        print({ message: `Complete GitHub ${step} in your browser: ${url}` });
      });
  }

  for (const [name, read] of [
    ["status", context.githubStatus],
    ["installations", context.githubInstallations],
    ["list", context.githubList],
  ] as const) {
    github.command(name).action(async () => print(await read()));
  }

  /** A command that names an asset and the GitHub repository it pairs with. */
  const repositoryCommand = (name: string) =>
    github
      .command(`${name} <name>`)
      .addOption(
        new Option("--kind <kind>", "Git-backed asset kind")
          .choices(packageKindList)
          .default("skill"),
      )
      .requiredOption("--origin <origin>", ORIGIN_HELP)
      .requiredOption(
        "--installation <id>",
        "BarnDog installation binding UUID",
      )
      .requiredOption(
        "--repository <owner/name>",
        "Customer-selected GitHub repository",
      );

  repositoryCommand("connect")
    .addOption(
      new Option("--mode <mode>", "mirror keeps BarnDog authoritative")
        .choices(["connect", "transfer", "mirror"])
        .default("connect"),
    )
    .option("--expected-version <id>", "Inspected BarnDog version ID")
    .action(async (name: string, options: Omit<GithubConnectOptions, "name">) =>
      print(await context.githubConnect({ ...options, name })),
    );

  repositoryCommand("import")
    .addOption(
      new Option(
        "--authority <authority>",
        "Copy into BarnDog or keep GitHub authoritative",
      )
        .choices(["barndog", "github"])
        .default("github"),
    )
    .option(
      "--key <key>",
      "Required for BarnDog-owned copies; retain for exact retries",
    )
    .action(
      async (
        name: string,
        {
          authority,
          key,
          ...target
        }: Omit<GithubRepositoryOptions, "name"> & {
          authority: "barndog" | "github";
          key?: string;
        },
      ) => {
        if (authority === "github") {
          return print(await context.githubImport({ ...target, name }));
        }

        if (!key) {
          throw new Error("Use --key <key> and retain it for exact retries");
        }

        print(await context.githubImportCopy({ ...target, name, key }));
      },
    );

  github
    .command("create-repository <name>")
    .description("Create a GitHub repository and export published history")
    .addOption(
      new Option("--kind <kind>", "Asset kind")
        .choices(packageKindList)
        .default("skill"),
    )
    .requiredOption("--origin <origin>", ORIGIN_HELP)
    .requiredOption("--installation <id>", "BarnDog installation binding UUID")
    .requiredOption("--repository <owner/name>", "New repository to create")
    .requiredOption("--key <key>", "Stable key; retain for exact retries")
    .requiredOption("--expected-version <id>", "Inspected BarnDog version")
    .addOption(
      new Option("--mode <mode>", "Content authority after export")
        .choices(["mirror", "transfer"])
        .default("mirror"),
    )
    .addOption(
      new Option("--visibility <visibility>", "New repository visibility")
        .choices(["private", "public"])
        .default("private"),
    )
    .action(
      async (
        name: string,
        options: Omit<GithubCreateRepositoryOptions, "name">,
      ) => print(await context.githubCreateRepository({ ...options, name })),
    );

  for (const [name, read] of [
    ["show", context.githubShow],
    ["sync", context.githubSync],
    ["remote-head", context.githubRemoteHead],
  ] as const) {
    github
      .command(`${name} <id>`)
      .action(async (id: string) => print(await read(id)));
  }

  github
    .command("resolve-mirror <id>")
    .addOption(
      new Option("--action <action>", "Explicit divergence resolution")
        .choices(["use-barndog", "use-mirror", "disconnect"])
        .makeOptionMandatory(),
    )
    .requiredOption("--expected-version <id>", "Inspected BarnDog version")
    .requiredOption(
      "--expected-remote <sha|absent>",
      "Inspected remote main SHA or absent",
    )
    .option("--key <key>", "Stable key for exact retries")
    .action(
      async (
        id: string,
        {
          expectedRemote,
          ...options
        }: Pick<GithubResolveMirrorOptions, "action" | "expectedVersion"> & {
          expectedRemote: string;
          key?: string;
        },
      ) =>
        print(
          await context.githubResolveMirror({
            ...options,
            connectionId: id,
            expectedRemoteCommit:
              expectedRemote === "absent" ? null : expectedRemote,
          }),
        ),
    );

  const pulls = github
    .command("pulls")
    .description("Inspect and contribute to externally authoritative assets");

  pulls
    .command("list <id>")
    .action(async (id: string) => print(await context.githubPullsList(id)));

  pulls
    .command("show <id> <number>")
    .action(async (id: string, number: string) =>
      print(await context.githubPullsShow(id, positiveInteger(number))),
    );

  pulls
    .command("create <id>")
    .requiredOption("--expected-commit <sha>", "Inspected canonical commit")
    .requiredOption("--title <title>", "Pull request title")
    .option("--directory <path>", "Complete editable package directory")
    .option("--body <text>", "Pull request body")
    .option("--body-file <path>", "Pull request body file")
    .option("--key <key>", "Stable key for exact retries")
    .action(
      async (
        id: string,
        options: Omit<GithubPullsCreateOptions, "connectionId">,
      ) =>
        print(
          await context.githubPullsCreate({ ...options, connectionId: id }),
        ),
    );

  pulls
    .command("revise <id> <number>")
    .requiredOption("--expected-commit <sha>", "Inspected pull head commit")
    .option("--title <title>", "Updated title")
    .option("--directory <path>", "Complete package directory")
    .option("--body <text>", "Updated body")
    .option("--body-file <file>", "Updated body file")
    .option("--key <key>", "Stable key for exact retries")
    .action(
      async (
        id: string,
        number: string,
        options: Omit<GithubPullsReviseOptions, "connectionId" | "number">,
      ) =>
        print(
          await context.githubPullsRevise({
            ...options,
            connectionId: id,
            number: positiveInteger(number),
          }),
        ),
    );

  /** A command on one pull request, pinned to the commit that was inspected. */
  const pullCommand = (name: string) =>
    pulls
      .command(`${name} <id> <number>`)
      .requiredOption("--expected-commit <sha>", "Inspected pull head commit");

  const bodyOptions = (command: Command) =>
    command
      .option("--body <text>", "Review or comment")
      .option("--body-file <file>", "Review or comment file");

  bodyOptions(pullCommand("review"))
    .addOption(
      new Option("--event <event>", "Review decision")
        .choices(["APPROVE", "REQUEST_CHANGES", "COMMENT"])
        .makeOptionMandatory(),
    )
    .action(
      async (
        id: string,
        number: string,
        options: Omit<GithubPullsReviewOptions, "connectionId" | "number">,
      ) =>
        print(
          await context.githubPullsReview({
            ...options,
            connectionId: id,
            number: positiveInteger(number),
          }),
        ),
    );

  bodyOptions(pullCommand("comment"))
    .option("--path <file>", "Inline file")
    .option("--line <number>", "Inline line", positiveInteger)
    .addOption(
      new Option("--side <side>", "Inline diff side").choices([
        "LEFT",
        "RIGHT",
      ]),
    )
    .action(
      async (
        id: string,
        number: string,
        options: Omit<GithubPullsCommentOptions, "connectionId" | "number">,
      ) =>
        print(
          await context.githubPullsComment({
            ...options,
            connectionId: id,
            number: positiveInteger(number),
          }),
        ),
    );

  pullCommand("merge").action(
    async (id: string, number: string, options: { expectedCommit: string }) =>
      print(
        await context.githubPullsMerge({
          ...options,
          connectionId: id,
          number: positiveInteger(number),
        }),
      ),
  );

  const describe = (parent: Command, descriptions: Record<string, string>) => {
    for (const command of parent.commands) {
      const description = descriptions[command.name()];
      if (!command.description() && description) {
        command.description(description);
      }
    }
  };

  describe(github, {
    auth: "Link your GitHub account to BarnDog",
    install: "Install the BarnDog GitHub App on an account or organization",
    status: "Show your GitHub account and App connection",
    installations: "List GitHub App installations you can use",
    list: "List Skills and Hooks connected to GitHub repositories",
    connect: "Connect a Skill or Hook to a GitHub repository",
    import: "Import a Skill or Hook from a GitHub repository",
    show: "Show a GitHub connection",
    sync: "Sync a connection with its repository now",
    "remote-head": "Show the repository's current main commit",
    "resolve-mirror": "Resolve a mirror that diverged from BarnDog",
  });

  describe(pulls, {
    list: "List pull requests for a connected asset",
    show: "Show a pull request",
    create: "Open a pull request with your edits",
    revise: "Update an open pull request",
    review: "Approve or request changes on a pull request",
    comment: "Comment on a pull request",
    merge: "Merge a pull request",
  });
}
