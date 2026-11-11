import { InvalidArgumentError, type Command } from "commander";
import { styleText } from "node:util";
import type { CommandContext } from "./context.js";
import type {
  CollaborationAction,
  CollaborationOptions,
} from "../features/collaboration/index.js";
import { renderCollaboration } from "../ui/collaboration.js";
import {
  folderDivergence,
  nearestHookFolder,
} from "../features/hooks/divergence.js";
import { resolve } from "node:path";
import { CliError, friendlyHint, friendlyMessage } from "../errors.js";
import { ApiError } from "@barndog-ai/api-contract";
import { pickOne } from "../ui/pick.js";
import { resolveOrigin } from "./origin.js";
import { clean, json, ORIGIN_HELP, originLabel, warn } from "../ui/format.js";

function positive(value: string) {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new InvalidArgumentError("Expected a positive integer");
  return Number(value);
}

/** Skill and Hook changes are separate lists; point at the other when an ID isn't here. */
function reviewError(
  error: unknown,
  kind: "skill" | "hook",
  options: CollaborationOptions,
) {
  if (!(error instanceof ApiError)) return error;
  if (error.status === 404 && options.id && !options.thread)
    return new CliError(
      `No ${kind === "skill" ? "Skill" : "Hook"} Suggested Change has that ID.`,
      `barndog ${kind === "skill" ? "hooks changes" : "changes"} show ${options.id}`,
      { cause: error },
    );
  const hint = friendlyHint(error);
  return kind === "hook" && hint
    ? new CliError(
        friendlyMessage(error),
        hint.replace(/^barndog changes/, "barndog hooks changes"),
        { cause: error },
      )
    : error;
}

export function registerCollaboration(
  program: Command,
  context: CommandContext,
  kind: "skill" | "hook" = "skill",
) {
  const run = async (
    action: CollaborationAction,
    options: CollaborationOptions = {},
  ) => {
    const result = await context
      .collaborate(action, kind === "hook" ? { ...options, kind } : options)
      .catch((error: unknown) => {
        throw reviewError(error, kind, options);
      });
    if (context.mode.json) {
      context.write(json(result));
      return;
    }
    for (const line of renderCollaboration(action, result)) context.write(line);
    if (kind !== "hook" || (action !== "pull-skill" && action !== "push"))
      return;
    // Editing is when tools drifting apart matters, so say it at both ends.
    const pulled =
      action === "pull-skill"
        ? ((result as { root?: string } | null)?.root ??
          resolve(options.directory ?? options.name ?? "."))
        : nearestHookFolder(process.cwd());
    const warning = pulled && (await folderDivergence(pulled));
    if (warning) context.write(`${warn("!")} ${warning}`);
  };
  const skills = program.commands.find(
    (c) => c.name() === (kind === "hook" ? "hooks" : "skills"),
  )!;
  const noun = kind === "skill" ? "Skill" : "Hook";
  const group = kind === "skill" ? "skills" : "hooks";
  /** Fills a missing name and origin from a searchable catalog list. */
  const choose = async (
    name: string | undefined,
    origin: string | undefined,
    usage: string,
  ) => {
    if (name)
      return {
        name,
        origin: await resolveOrigin(
          context,
          kind,
          name,
          origin,
          usage.replace("<name>", name),
        ),
      };
    if (!context.mode.interactive)
      throw new CliError(`Name the ${noun} to use.`, usage);
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
  skills
    .command("pull [name]")
    .option("--origin <origin>", ORIGIN_HELP)
    .option("--directory <path>", "Folder for the editable copy")
    .description(
      `Download a ${noun} into an editable folder to change and propose edits`,
    )
    .action(async (name, options) =>
      run("pull-skill", {
        ...options,
        ...(await choose(name, options.origin, `barndog ${group} pull <name>`)),
      }),
    );
  if (kind === "skill") {
    for (const [command, description] of [
      [
        "pull",
        "Bring the latest published version into this working copy, keeping your edits",
      ],
      [
        "diff",
        "Show your edits in this working copy (elsewhere: preview what sync would change)",
      ],
    ] as const)
      program
        .command(command)
        .description(description)
        .action(() => run(command));
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
      .action((options) => run("push", options));
    program
      .command("resolve <path>")
      .description("Mark a conflicted file in this working copy as resolved")
      .action((path) => run("resolve", { path }));
  }
  for (const [name, action, description] of [
    [
      "versions",
      "versions",
      `List ${noun === "Skill" ? "a Skill's" : "a Hook's"} published versions`,
    ],
    ["show", "version-show", "Print the files of a published version"],
    ["diff", "version-diff", "Compare two published versions"],
  ] as const) {
    const command = skills
      .command(`${name} [name]`)
      .description(description)
      .option("--origin <origin>", ORIGIN_HELP);
    if (name === "show")
      command.option("--version <number>", "Published version", positive);
    if (name === "diff")
      command
        .requiredOption("--from <number>", "Old version", positive)
        .requiredOption("--to <number>", "New version", positive);
    command.action(async (asset, options) =>
      run(action, {
        ...options,
        ...(await choose(
          asset,
          options.origin,
          `barndog ${group} ${name} <name>`,
        )),
      }),
    );
  }
  skills
    .command("push [name]")
    .description("Propose this working copy's edits as a Suggested Change")
    .option(
      "--origin <origin>",
      "Scope for a new package, such as team/engineering",
    )
    .option("--publish", "Publish with direct authority")
    .option("--new", "Start a new proposal")
    .option("--title <title>", "Proposal title")
    .action((name, options) => run("push", { ...options, name }));
  skills
    .command("create <name>")
    .requiredOption("--origin <origin>", ORIGIN_HELP)
    .option("--directory <path>", "New editable folder")
    .description(
      `Start a new ${noun} in an editable folder (not installed until published)`,
    )
    .action((name, options) => run("create", { ...options, name }));
  for (const parent of kind === "hook" ? [skills] : [program, skills])
    registerChanges(parent, run);
}

function registerChanges(
  parent: Command,
  run: (
    action: CollaborationAction,
    options?: CollaborationOptions,
  ) => Promise<void>,
) {
  const changes = parent
    .command("changes")
    .description("Review, discuss and merge Suggested Changes");
  changes
    .command("list")
    .description("List accessible Suggested Changes")
    .action(() => run("list"));
  changes
    .command("show <id>")
    .description("Read proposal content, reviews, and discussion history")
    .action((id) => run("show", { id }));
  changes
    .command("diff <id>")
    .description("Inspect a proposal diff")
    .option("--revision <number>", "Proposal revision", positive)
    .option(
      "--from-revision <number>",
      "Compare to another proposal revision",
      positive,
    )
    .action((id, options) => run("change-diff", { ...options, id }));
  for (const [name, description] of [
    ["approve", "Approve a reviewed revision"],
    ["request-changes", "Request further changes"],
    ["reject", "Close a proposal as its author or admin"],
    ["merge", "Publish a proposal under its scope's merge rules"],
  ] as const)
    changes
      .command(`${name} <id>`)
      .description(description)
      .requiredOption("--revision <number>", "Revision you reviewed", positive)
      .action((id, options) => run(name, { ...options, id }));
  changes
    .command("comment <id>")
    .description("Comment, reply, or suggest an inline replacement")
    .requiredOption("--revision <number>", "Proposal revision", positive)
    .option("--body <text>", "Comment text")
    .option("--body-file <path>", "Read comment text from a file")
    .option("--thread <id>", "Reply to a discussion")
    .option("--path <path>", "Package file for an inline discussion")
    .option("--side <side>", "old or new")
    .option("--start-line <number>", "First line", positive)
    .option("--end-line <number>", "Last line", positive)
    .option("--replacement-file <path>", "Replacement text file")
    .option("--expected-file <path>", "Exact original text file")
    .action((id, options) => run("comment", { ...options, id }));
  for (const [name, description] of [
    ["apply", "Apply a current reviewer suggestion"],
    ["resolve-discussion", "Resolve a discussion"],
    ["reopen-discussion", "Reopen a discussion"],
  ] as const)
    changes
      .command(`${name} <id> <thread>`)
      .description(description)
      .requiredOption(
        "--revision <number>",
        "Current proposal revision",
        positive,
      )
      .action((id, thread, options) => run(name, { ...options, id, thread }));
  changes.addHelpText(
    "after",
    `\nReview ${styleText("bold", "barndog changes diff <id>")} before approving a revision. Approval does not publish; use ${styleText("bold", "barndog changes merge <id> --revision <number>")}.`,
  );
}
