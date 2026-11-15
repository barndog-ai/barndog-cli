import { CliError } from "../errors.js";
import { scopeExists } from "../features/imports/discover.js";
import { type UpdateMode } from "../features/imports/local.js";
import { type RemoteRepo } from "../features/imports/remote.js";
import { synchronize } from "../features/environment/sync.js";
import { warn } from "./format.js";
import { type AddPrompts } from "./add-prompts.js";

export type AddOptions = {
  updates?: UpdateMode;
  copy?: boolean;
  move?: boolean;
  as?: string;
  only?: string[];
  all?: boolean;
  description?: string;
  config?: string;
  file?: string;
  from?: string;
  replace?: boolean;
  oauth?: boolean;
};

/**
 * Where the add commands write and how they ask; `interactive` false means no
 * prompts, so choices must come from flags.
 */
export type AddContext = {
  home: string;
  interactive: boolean;
  write: (line: string) => void;
  prompts: AddPrompts;
};

const updateChoices: {
  name: string;
  value: UpdateMode;
  description: string;
}[] = [
  {
    name: "Update when I ask",
    value: "manual",
    description:
      "Remembers the repo. `update` pulls the latest and shows what changed.",
  },
  {
    name: "Fork",
    value: "fork",
    description: "Your own copy. BarnDog forgets where it came from.",
  },
  {
    name: "Update automatically",
    value: "auto",
    description:
      "Every sync takes the latest. Anyone with push rights to that repo can change what runs here.",
  },
];

export async function updateMode(options: AddOptions, context: AddContext) {
  if (options.updates) {
    return options.updates;
  }

  if (!context.interactive) {
    return "manual";
  }

  const mode = await context.prompts.chooseOne(
    "How should it stay up to date?",
    updateChoices,
    "manual",
  );

  return (
    updateChoices.find((choice) => choice.value === mode)?.value ?? "manual"
  );
}

export async function finish(context: AddContext) {
  const events = await synchronize(undefined, context.home, undefined, {
    prompt: false,
  });

  for (const event of events) {
    if (event.type === "invalid") {
      context.write(`${warn("!")} ${event.name}: ${event.reason}`);
    }
  }
}

export const folderLabel = (root: string) => root || "repo root";

/** A link to a folder is searched on its own, so a miss there says so. */
export function notFound(
  remote: RemoteRepo,
  url: string,
  kind: "Skill" | "Hook",
) {
  const command = `barndog ${kind === "Skill" ? "skills" : "hooks"} add`;
  const expects =
    kind === "Skill"
      ? "A Skill is a folder with a SKILL.md."
      : "A Hook is a folder with hook.yaml, hook settings, or scripts.";

  if (!scopeExists(remote)) {
    return new CliError(
      `Can't find ${remote.path} in ${remote.url}${remote.ref ? ` at ${remote.ref}` : ""}.`,
      `${command} ${remote.url}`,
    );
  }

  if (remote.path) {
    return new CliError(
      `No valid ${kind} found in ${remote.path} or the folders below it. ${expects} BarnDog only looks where the link points, not in the rest of the repo.`,
      `${command} ${remote.url}`,
    );
  }

  return new CliError(`No valid ${kind} found in ${url}. ${expects}`);
}
