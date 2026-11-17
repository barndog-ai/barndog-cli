/** `barndog skills add`: brings Skills from a repository or folder into the local workspace. */
import type { RuntimeContext } from "../runtime.js";
import { join } from "node:path";
import { CliError } from "../errors.js";
import {
  discoverSkills,
  type SkillCandidate,
} from "../features/imports/discover.js";
import { renamedSkill, saveImported } from "../features/imports/local.js";
import {
  assertSourceExists,
  plainFolder,
  readFolder,
  removeImported,
} from "../features/imports/folder.js";
import {
  fetchRemote,
  parseLocation,
  type RemoteRepo,
} from "../features/imports/remote.js";
import { bold, dim, ok, warn } from "./format.js";
import { defined } from "../shared/lookup.js";
import {
  finish,
  folderLabel,
  assertDistinctNames,
  notFound,
  onlyChosen,
  type AddContext,
  type AddOptions,
  updateMode,
} from "./add-asset.js";

/** Stops two copies of a Skill from claiming the same name, saying which folders hold them. */
/** A plain folder is read in place; everything else is fetched with Git. */
async function withSkillSource(
  source: string,
  folder: string | null,
  runtime: RuntimeContext,
  use: (remote: RemoteRepo) => Promise<void>,
) {
  if (folder) {
    return use(await readFolder(folder, runtime));
  }

  return fetchRemote(
    parseLocation(source),
    { allowPrompt: true },
    use,
    runtime,
  );
}

function assertFolderOptions(options: AddOptions, folder: string | null) {
  if (!folder && (options.copy || options.move)) {
    throw new CliError(
      `--${options.copy ? "copy" : "move"} only applies when adding from a local folder.`,
    );
  }

  if (folder && options.updates && options.updates !== "fork") {
    throw new CliError(
      "A plain folder has no history to update from, so --updates doesn't apply.",
      "barndog skills add <folder> --copy",
    );
  }
}

async function folderTransfer(
  count: number,
  options: AddOptions,
  context: AddContext,
) {
  if (options.move) {
    return "move";
  }

  if (options.copy || !context.interactive) {
    return "copy";
  }

  return context.prompts.chooseOne(
    `Copy or move ${count === 1 ? "it" : "them"} into your workspace?`,
    [
      {
        name: "Copy",
        value: "copy",
        description:
          "Leaves the original where it is. Later edits to it won't carry over.",
      },
      {
        name: "Move",
        value: "move",
        description:
          "Deletes the imported files from the original folder once they're in your workspace.",
      },
    ],
    "copy",
  );
}

/**
 * `skills add <url>`: copies Skills from a repository, a harness folder or a
 * plain folder into the local workspace.
 */
export async function addSkills(
  url: string,
  options: AddOptions,
  context: AddContext,
) {
  assertSourceExists(url, context.runtime);
  const folder = await plainFolder(url, context.runtime);
  assertFolderOptions(options, folder);
  await withSkillSource(url, folder, context.runtime, async (remote) => {
    const { skills, skipped } = discoverSkills(remote);
    for (const skip of skipped) {
      context.write(`${warn("!")} ${skip.path}: ${skip.reason}`);
    }

    if (!skills.length) {
      throw notFound(remote, url, "Skill");
    }

    const repeated = (name: string) =>
      skills.filter((s) => s.name === name).length > 1;

    const distinctName = (s: SkillCandidate) =>
      repeated(s.name) ? `${s.name} (${folderLabel(s.root)})` : s.name;

    let chosen = skills;
    const { only } = options;
    if (only?.length) {
      chosen = onlyChosen(skills, only, { url, kind: "skill" });
    } else if (skills.length > 1 && !options.all) {
      if (!context.interactive) {
        throw new CliError(
          `${url} has ${skills.length} Skills: ${skills.map(distinctName).join(", ")}.`,
          "barndog skills add <url> --only <name or folder>",
        );
      }

      const picked = await context.prompts.chooseMany(
        "Which Skills do you want?",
        skills.map((s) => ({
          name: `${s.name}  ${dim(folderLabel(s.root))}`,
          value: s.root,
          short: distinctName(s),
          description: `Description: ${s.description}`,
        })),
      );

      chosen = skills.filter((s) => picked.includes(s.root));
    }

    if (!chosen.length) {
      throw new CliError("No Skills were chosen, so nothing was added.");
    }

    assertDistinctNames(chosen, { url, kind: "skill" });
    if (options.as && chosen.length !== 1) {
      throw new CliError("--as renames one Skill, so choose exactly one.");
    }

    const transfer = folder
      ? await folderTransfer(chosen.length, options, context)
      : null;

    const mode = folder ? "fork" : await updateMode(options, context);
    for (const skill of chosen) {
      const name = options.as ?? skill.name;
      await saveImported(
        {
          kind: "skill",
          name,
          entries: renamedSkill(skill, name),
          mode,
          remote,
          root: skill.root,
        },
        context.runtime,
      );

      if (transfer !== "move") {
        context.write(`${ok("✔")} Added ${bold(name)}`);
        continue;
      }

      const original = join(
        defined(folder, "Only a local folder can be moved"),
        skill.root,
      );

      const gone = await removeImported(original, skill.entries);
      context.write(`${ok("✔")} Moved ${bold(name)} into your workspace`);
      if (!gone) {
        context.write(
          dim(`  ${original} has other files, so it was left in place.`),
        );
      }
    }
  });

  await finish(context);
}
