import { HTTP_STATUS } from "../shared/constants.js";

import { InvalidArgumentError, type Command } from "commander";
import { styleText } from "node:util";
import type { CommandContext } from "./context.js";
import { renderCollaboration } from "../ui/collaboration.js";
import {
  folderDivergence,
  nearestHookFolder,
} from "../features/hooks/divergence.js";
import { resolve } from "node:path";
import { CliError, friendlyHint, friendlyMessage } from "../errors.js";
import { ApiError } from "@barndog-ai/api-contract";
import type {
  CommentOptions,
  PushOptions,
} from "../features/collaboration/index.js";
import {
  assetKinds,
  packageKindList,
  type PackageKind,
} from "../features/asset-kinds/index.js";
import { pickOne } from "../ui/pick.js";
import { resolveOrigin } from "./origin.js";
import { clean, json, ORIGIN_HELP, originLabel, warn } from "../ui/format.js";
import { defined } from "../shared/lookup.js";
import { positiveInteger } from "../ui/options.js";

function side(value: string) {
  if (value !== "old" && value !== "new") {
    throw new InvalidArgumentError("Expected old or new");
  }

  return value;
}

type RunOptions = {
  /** The Suggested Change, and discussion, that an error refers to. */
  changeId?: string;
  thread?: string;
  /** Print a Suggested Change with its reviews, discussions and files. */
  details?: boolean;
};

type Run = (operation: Promise<unknown>, options?: RunOptions) => Promise<void>;

type WithKind = <T extends object>(options: T) => T & { kind?: "hook" };

/** Skill changes also have the root `barndog changes`, which server hints name. */
const changesCommand: Record<PackageKind, string> = {
  skill: "barndog changes",
  hook: "barndog hooks changes",
};

/** Each package kind has its own list of changes; point at the others when an ID isn't here. */
function reviewError(
  error: unknown,
  kind: PackageKind,
  { changeId, thread }: RunOptions,
) {
  if (!(error instanceof ApiError)) {
    return error;
  }

  if (error.status === HTTP_STATUS.notFound && changeId && !thread) {
    return new CliError(
      `No ${assetKinds[kind].one} Suggested Change has that ID.`,
      packageKindList
        .filter((other) => other !== kind)
        .map((other) => `${changesCommand[other]} show ${changeId}`)
        .join(" or "),
      { cause: error },
    );
  }

  const hint = friendlyHint(error);
  const ownHint = hint?.replace(/^barndog changes/, changesCommand[kind]);

  return ownHint !== hint
    ? new CliError(friendlyMessage(error), ownHint, { cause: error })
    : error;
}

/**
 * Registers working-copy and review commands; handlers use the supplied
 * services and output mode.
 */
export function registerCollaboration(
  program: Command,
  context: CommandContext,
  kind: PackageKind = "skill",
) {
  // Skill is the default package kind, so only Hook operations name theirs.
  const withKind: WithKind = (options) =>
    kind === "hook" ? { ...options, kind } : options;

  const run: Run = async (operation, options = {}) => {
    const result = await operation.catch((error: unknown) => {
      throw reviewError(error, kind, options);
    });

    if (context.mode.json) {
      context.write(json(result));
    } else {
      for (const line of renderCollaboration(result, options)) {
        context.write(line);
      }
    }
  };

  /** Editing is when tools drifting apart matters, so Hooks say it at both ends. */
  const warnDivergence = async (folder: string | null) => {
    if (kind !== "hook" || context.mode.json) {
      return;
    }

    const warning = folder && (await folderDivergence(folder));
    if (warning) {
      context.write(`${warn("!")} ${warning}`);
    }
  };

  const push = async (options: PushOptions) => {
    await run(context.pushWorkingCopy(withKind(options)));
    await warnDivergence(nearestHookFolder(process.cwd()));
  };

  const noun = assetKinds[kind].one;
  const group = assetKinds[kind].command;
  const kindCommand = defined(
    program.commands.find((c) => c.name() === group),
    `Command group ${group} isn't registered`,
  );

  /** Fills a missing name and origin from a searchable catalog list. */
  const choose = async (
    name: string | undefined,
    origin: string | undefined,
    usage: string,
  ) => {
    if (name) {
      return {
        name,
        origin: await resolveOrigin(context, {
          kind,
          name,
          origin,
          usage: usage.replace("<name>", name),
        }),
      };
    }

    if (!context.mode.interactive) {
      throw new CliError(`Name the ${noun} to use.`, usage);
    }

    const rows = await context.searchCatalog(kind);
    const row = await pickOne(
      `Choose a ${noun}`,
      rows.map((row) => ({
        value: row,
        name: row.name,
        hint: `${originLabel(row.origin)} · ${clean(row.version.description)}`,
      })),
      { empty: `No ${noun}s are published yet.` },
    );

    return { name: row.name, origin: originLabel(row.origin) };
  };

  kindCommand
    .command("pull [name]")
    .option("--origin <origin>", ORIGIN_HELP)
    .option("--directory <path>", "Folder for the editable copy")
    .description(
      `Download a ${noun} into an editable folder to change and propose edits`,
    )
    .action(
      async (
        name: string | undefined,
        options: { origin?: string; directory?: string },
      ) => {
        const target = {
          ...options,
          ...(await choose(
            name,
            options.origin,
            `barndog ${group} pull <name>`,
          )),
        };

        const pulled = context.pullPackage(withKind(target));
        await run(pulled);
        await warnDivergence(
          (await pulled)?.root ?? resolve(target.directory ?? target.name),
        );
      },
    );

  if (kind === "skill") {
    program
      .command("pull")
      .description(
        "Bring the latest published version into this working copy, keeping your edits",
      )
      .action(() => run(context.updateWorkingCopy()));

    program
      .command("diff")
      .description(
        "Show your edits in this working copy (elsewhere: preview what sync would change)",
      )
      .action(() => run(context.workingDiff()));

    program
      .command("push")
      .description("Propose this working copy's edits as a Suggested Change")
      .option("--origin <origin>", "Origin for a new local Skill")
      .option(
        "--publish",
        "Publish directly with admin or personal-owner authority",
      )
      .option(
        "--new",
        "Start a new proposal instead of updating the linked proposal",
      )
      .option("--title <title>", "Suggested Change title")
      .action(push);

    program
      .command("resolve <path>")
      .description("Mark a conflicted file in this working copy as resolved")
      .action((path: string) => run(context.resolveFile(path)));
  }

  for (const [name, description] of [
    [
      "versions",
      `List ${noun === "Skill" ? "a Skill's" : "a Hook's"} published versions`,
    ],
    ["show", "Print the files of a published version"],
    ["diff", "Compare two published versions"],
  ] as const) {
    const command = kindCommand
      .command(`${name} [name]`)
      .description(description)
      .option("--origin <origin>", ORIGIN_HELP);

    if (name === "show") {
      command.option(
        "--version <number>",
        "Published version",
        positiveInteger,
      );
    }

    if (name === "diff") {
      command
        .requiredOption("--from <number>", "Old version", positiveInteger)
        .requiredOption("--to <number>", "New version", positiveInteger);
    }

    command.action(
      async (
        asset: string | undefined,
        options: {
          origin?: string;
          version?: number;
          from: number;
          to: number;
        },
      ) => {
        const target = withKind({
          ...options,
          ...(await choose(
            asset,
            options.origin,
            `barndog ${group} ${name} <name>`,
          )),
        });

        if (name === "versions") {
          await run(context.packageVersions(target));
        } else if (name === "show") {
          await run(context.versionFiles(target));
        } else {
          await run(context.diffVersions(target));
        }
      },
    );
  }

  kindCommand
    .command("push [name]")
    .description("Propose this working copy's edits as a Suggested Change")
    .option(
      "--origin <origin>",
      "Scope for a new package, such as team/engineering",
    )
    .option("--publish", "Publish with direct authority")
    .option("--new", "Start a new proposal")
    .option("--title <title>", "Proposal title")
    .action((name: string | undefined, options: PushOptions) =>
      push({ ...options, name }),
    );

  kindCommand
    .command("create <name>")
    .requiredOption("--origin <origin>", ORIGIN_HELP)
    .option("--directory <path>", "New editable folder")
    .description(
      `Start a new ${noun} in an editable folder (not installed until published)`,
    )
    .action((name: string, options: { origin: string; directory?: string }) =>
      run(context.createPackage(withKind({ ...options, name }))),
    );

  for (const parent of kind === "hook"
    ? [kindCommand]
    : [program, kindCommand]) {
    registerChanges(parent, context, withKind, run);
  }
}

function registerChanges(
  parent: Command,
  context: CommandContext,
  withKind: WithKind,
  run: Run,
) {
  const changes = parent
    .command("changes")
    .description("Review, discuss and merge Suggested Changes");

  changes
    .command("list")
    .description("List accessible Suggested Changes")
    .action(() => run(context.listChanges(withKind({}))));

  changes
    .command("show <id>")
    .description("Read proposal content, reviews, and discussion history")
    .action((id: string) =>
      run(context.showChange(withKind({ id })), {
        changeId: id,
        details: true,
      }),
    );

  changes
    .command("diff <id>")
    .description("Inspect a proposal diff")
    .option("--revision <number>", "Proposal revision", positiveInteger)
    .option(
      "--from-revision <number>",
      "Compare to another proposal revision",
      positiveInteger,
    )
    .action(
      (id: string, options: { revision?: number; fromRevision?: number }) =>
        run(context.changeDiff(withKind({ ...options, id })), {
          changeId: id,
        }),
    );

  for (const [name, description] of [
    ["approve", "Approve a reviewed revision"],
    ["request-changes", "Request further changes"],
    ["reject", "Close a proposal as its author or admin"],
    ["merge", "Publish a proposal under its scope's merge rules"],
  ] as const) {
    changes
      .command(`${name} <id>`)
      .description(description)
      .requiredOption(
        "--revision <number>",
        "Revision you reviewed",
        positiveInteger,
      )
      .action((id: string, options: { revision: number }) => {
        const target = withKind({ ...options, id });

        const labels = { changeId: id };

        if (name === "reject") {
          return run(context.rejectChange(target), labels);
        }

        if (name === "merge") {
          return run(context.mergeChange(target), labels);
        }

        return run(context.reviewChange(name, target), labels);
      });
  }

  changes
    .command("comment <id>")
    .description("Comment, reply, or suggest an inline replacement")
    .requiredOption("--revision <number>", "Proposal revision", positiveInteger)
    .option("--body <text>", "Comment text")
    .option("--body-file <path>", "Read comment text from a file")
    .option("--thread <id>", "Reply to a discussion")
    .option("--path <path>", "Package file for an inline discussion")
    .option("--side <side>", "old or new", side)
    .option("--start-line <number>", "First line", positiveInteger)
    .option("--end-line <number>", "Last line", positiveInteger)
    .option("--replacement-file <path>", "Replacement text file")
    .option("--expected-file <path>", "Exact original text file")
    .action((id: string, options: Omit<CommentOptions, "id" | "kind">) =>
      run(context.commentOnChange(withKind({ ...options, id })), {
        changeId: id,
        thread: options.thread,
      }),
    );

  for (const [name, description] of [
    ["apply", "Apply a current reviewer suggestion"],
    ["resolve-discussion", "Resolve a discussion"],
    ["reopen-discussion", "Reopen a discussion"],
  ] as const) {
    changes
      .command(`${name} <id> <thread>`)
      .description(description)
      .requiredOption(
        "--revision <number>",
        "Current proposal revision",
        positiveInteger,
      )
      .action((id: string, thread: string, options: { revision: number }) => {
        const target = withKind({ ...options, id, thread });

        return run(
          name === "apply"
            ? context.applySuggestion(target)
            : context.setDiscussionResolved({
                ...target,
                resolved: name === "resolve-discussion",
              }),
          { changeId: id, thread },
        );
      });
  }

  changes.addHelpText(
    "after",
    `\nReview ${styleText("bold", "barndog changes diff <id>")} before approving a revision. Approval does not publish; use ${styleText("bold", "barndog changes merge <id> --revision <number>")}.`,
  );
}
