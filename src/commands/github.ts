import { openBrowser } from "../ui/auth.js";
import { ORIGIN_HELP } from "../ui/format.js";
import { Option, type Command } from "commander";
import { type CommandContext } from "./context.js";
import { packageKindList } from "../config/selection.js";
import {
  type GithubConnectOptions,
  type GithubCreateRepositoryOptions,
  type GithubRepositoryOptions,
  type GithubResolveMirrorOptions,
} from "../features/github/connections.js";
import {
  type GithubPullsCommentOptions,
  type GithubPullsCreateOptions,
  type GithubPullsReviewOptions,
  type GithubPullsReviseOptions,
} from "../features/github/pulls.js";
import { positiveInteger } from "../ui/options.js";
import { CliError } from "../errors.js";
import { commandHelpers } from "./helpers.js";

/** `barndog github`: the GitHub App, connections, mirrors and pull requests. */
export function registerGithub(program: Command, context: CommandContext) {
  const { print } = commandHelpers(context);

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
          throw new CliError(
            "Add --key <key>, and reuse the same key to retry exactly.",
          );
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
