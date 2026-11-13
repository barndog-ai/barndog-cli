import checkbox from "@inquirer/checkbox";
import confirm from "@inquirer/confirm";
import input from "@inquirer/input";
import select from "@inquirer/select";
import { createInterface } from "node:readline";
import { basename, join } from "node:path";

import { CliError } from "../errors.js";
import {
  adapters,
  harnesses,
  type Harness,
  isHarness,
} from "../harnesses/registry.js";
import {
  buildHookPackage,
  discoverHooks,
  discoverSkills,
  plainCommand,
  scopeExists,
  type DraftEvent,
  type HookCandidate,
  type SkillCandidate,
} from "../features/imports/discover.js";
import { adaptHook, toolNames } from "../features/hooks/adapt.js";
import { folderDivergence } from "../features/hooks/divergence.js";
import { LOCAL_ORIGIN } from "../features/git-workspace/overlay.js";
import {
  renamedSkill,
  saveImported,
  type UpdateMode,
} from "../features/imports/local.js";
import {
  addMcpServers,
  conflictingEntries,
  convertServer,
  harnessServers,
  parseMcpText,
  type ImportedServer,
} from "../features/imports/mcp.js";
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
import { synchronize } from "../features/environment/sync.js";
import { readFile } from "node:fs/promises";
import { bold, dim, ok, warn } from "./format.js";
import { checkboxTheme, promptTheme } from "./theme.js";
import { setYamlName, slugify } from "../shared/patterns.js";
import { defined, only } from "../shared/lookup.js";

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

export type AddPrompts = {
  chooseMany: (
    message: string,
    choices: {
      name: string;
      value: string;
      short?: string;
      description?: string;
      checked?: boolean;
    }[],
  ) => Promise<string[]>;
  chooseOne: (
    message: string,
    choices: { name: string; value: string; description?: string }[],
    fallback?: string,
  ) => Promise<string>;
  text: (message: string, fallback?: string) => Promise<string>;
  yes: (message: string, fallback?: boolean) => Promise<boolean>;
  paste: () => Promise<string>;
};

/** Reads pasted lines until they form complete JSON, so nobody has to press Ctrl+D. */
function pasteJson(write: (line: string) => void) {
  write(dim("Paste the JSON. It's read as soon as it's complete."));
  return new Promise<string>((resolve) => {
    const lines: string[] = [];
    const reader = createInterface({ input: process.stdin });
    reader.on("line", (line) => {
      lines.push(line);
      try {
        JSON.parse(lines.join("\n"));
        reader.close();
      } catch {
        // Not complete yet.
      }
    });
    reader.on("close", () => resolve(lines.join("\n")));
  });
}

export const terminalPrompts = (write: (line: string) => void): AddPrompts => ({
  chooseMany: (message, choices) =>
    checkbox({
      message,
      choices,
      pageSize: 12,
      loop: false,
      theme: checkboxTheme,
    }),
  chooseOne: (message, choices, fallback) =>
    select({
      message,
      choices,
      default: fallback,
      pageSize: 12,
      loop: false,
      theme: promptTheme,
    }),
  text: (message, fallback) =>
    input({ message, default: fallback, theme: promptTheme }),
  yes: (message, fallback = true) =>
    confirm({ message, default: fallback, theme: promptTheme }),
  paste: () => pasteJson(write),
});

export type AddContext = {
  home?: string;
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

async function updateMode(options: AddOptions, context: AddContext) {
  if (options.updates) return options.updates;
  if (!context.interactive) return "manual";
  const mode = await context.prompts.chooseOne(
    "How should it stay up to date?",
    updateChoices,
    "manual",
  );
  return (
    updateChoices.find((choice) => choice.value === mode)?.value ?? "manual"
  );
}

async function finish(context: AddContext) {
  const events = await synchronize(undefined, context.home, undefined, {
    prompt: false,
  });
  for (const event of events)
    if (event.type === "invalid")
      context.write(`${warn("!")} ${event.name}: ${event.reason}`);
}

const folderLabel = (root: string) => root || "repo root";

/** A link to a folder is searched on its own, so a miss there says so. */
function notFound(remote: RemoteRepo, url: string, kind: "Skill" | "Hook") {
  const command = `barndog ${kind === "Skill" ? "skills" : "hooks"} add`;
  const expects =
    kind === "Skill"
      ? "A Skill is a folder with a SKILL.md."
      : "A Hook is a folder with hook.yaml, hook settings, or scripts.";
  if (!scopeExists(remote))
    return new CliError(
      `Can't find ${remote.path} in ${remote.url}${remote.ref ? ` at ${remote.ref}` : ""}.`,
      `${command} ${remote.url}`,
    );
  if (remote.path)
    return new CliError(
      `No valid ${kind} found in ${remote.path} or the folders below it. ${expects} BarnDog only looks where the link points, not in the rest of the repo.`,
      `${command} ${remote.url}`,
    );
  return new CliError(`No valid ${kind} found in ${url}. ${expects}`);
}

/** Stops two copies of a Skill from claiming the same name, saying which folders hold them. */
function assertDistinctNames(chosen: SkillCandidate[], url: string) {
  const clash = chosen.find(
    (skill, index) => chosen.findIndex((s) => s.name === skill.name) !== index,
  );
  if (!clash) return;
  const copies = chosen.filter((s) => s.name === clash.name);
  throw new CliError(
    `${clash.name} is in more than one folder: ${copies.map((s) => folderLabel(s.root)).join(", ")}. Choose one.`,
    `barndog skills add ${url} --only ${copies.find((s) => s.root)?.root ?? clash.name}`,
  );
}

/** A plain folder is read in place; everything else is fetched with Git. */
async function withSkillSource(
  source: string,
  folder: string | null,
  use: (remote: RemoteRepo) => Promise<void>,
) {
  if (folder) return use(await readFolder(folder));
  return fetchRemote(parseLocation(source), { allowPrompt: true }, use);
}

function assertFolderOptions(options: AddOptions, folder: string | null) {
  if (!folder && (options.copy || options.move))
    throw new CliError(
      `--${options.copy ? "copy" : "move"} only applies when adding from a local folder.`,
    );
  if (folder && options.updates && options.updates !== "fork")
    throw new CliError(
      "A plain folder has no history to update from, so --updates doesn't apply.",
      "barndog skills add <folder> --copy",
    );
}

async function folderTransfer(
  count: number,
  options: AddOptions,
  context: AddContext,
) {
  if (options.move) return "move";
  if (options.copy || !context.interactive) return "copy";
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

export async function addSkills(
  url: string,
  options: AddOptions,
  context: AddContext,
) {
  assertSourceExists(url);
  const folder = await plainFolder(url);
  assertFolderOptions(options, folder);
  await withSkillSource(url, folder, async (remote) => {
    const { skills, skipped } = discoverSkills(remote);
    for (const skip of skipped)
      context.write(`${warn("!")} ${skip.path}: ${skip.reason}`);
    if (!skills.length) throw notFound(remote, url, "Skill");
    const repeated = (name: string) =>
      skills.filter((s) => s.name === name).length > 1;
    const distinctName = (s: SkillCandidate) =>
      repeated(s.name) ? `${s.name} (${folderLabel(s.root)})` : s.name;
    let chosen = skills;
    const { only } = options;
    if (only?.length)
      chosen = skills.filter(
        (s) => only.includes(s.name) || only.includes(s.root),
      );
    else if (skills.length > 1 && !options.all) {
      if (!context.interactive)
        throw new CliError(
          `${url} has ${skills.length} Skills: ${skills.map(distinctName).join(", ")}.`,
          "barndog skills add <url> --only <name or folder>",
        );
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
    if (!chosen.length)
      throw new CliError("No Skills were chosen, so nothing was added.");
    assertDistinctNames(chosen, url);
    if (options.as && chosen.length !== 1)
      throw new CliError("--as renames one Skill, so choose exactly one.");
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
        context.home,
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
      if (!gone)
        context.write(
          dim(`  ${original} has other files, so it was left in place.`),
        );
    }
  });
  await finish(context);
}

/** Scripts with no settings anywhere: the person says which tools and events run them. */
export async function pickHookPlan(
  draft: Extract<HookCandidate, { type: "draft" }>,
  executable: (script: string) => boolean,
  context: AddContext,
) {
  const { prompts } = context;
  // Choices made for one coding tool start out selected for the next.
  const carried = new Map<string, DraftEvent>();
  const chosen = (
    await prompts.chooseMany(
      "Which coding tools should this Hook support?",
      harnesses.map((h) => ({ name: adapters[h].name, value: h })),
    )
  ).filter(isHarness);
  const plan: Partial<Record<Harness, DraftEvent[]>> = {};
  for (const harness of chosen) {
    const known = adapters[harness].hooks.events;
    const events = await prompts.chooseMany(
      `${adapters[harness].name}: which events should run it?`,
      known.map(({ name }) => ({
        name,
        value: name,
        checked: carried.has(name.toLowerCase()),
      })),
    );
    const drafts: DraftEvent[] = [];
    for (const event of events) {
      const script =
        only(draft.scripts) ??
        (await prompts.chooseOne(
          `${adapters[harness].name} ${event}: which script?`,
          draft.scripts.map((s) => ({ name: s, value: s })),
          carried.get(event.toLowerCase())?.script,
        ));
      const hint = known.find((e) => e.name === event)?.matcher;
      const matcher = hint
        ? (await prompts.text(`${event} matcher (${hint})`, "")).trim() ||
          undefined
        : undefined;
      const picked = {
        event,
        matcher,
        script,
        command: plainCommand(script, executable(script)),
      };
      drafts.push(picked);
      carried.set(event.toLowerCase(), picked);
    }
    if (drafts.length) plan[harness] = drafts;
  }
  return plan;
}

/** Says which of this machine's coding tools a new Hook leaves out, with one prompt for all. */
async function reportCoverage(
  name: string,
  folder: string,
  context: AddContext,
) {
  const divergence = await folderDivergence(folder);
  if (divergence) context.write(`${warn("!")} ${divergence}`);
  const { written, targets, prompt } = await adaptHook(
    name,
    LOCAL_ORIGIN,
    undefined,
    context.home,
  );
  if (!prompt) return;
  context.write(
    `${warn("!")} ${bold(name)} was written for ${toolNames(written)}. It won't run in ${toolNames(targets, "or")}: BarnDog doesn't adapt Hooks between coding tools.`,
  );
  context.write(
    dim("  An AI agent can check whether it can be adapted. Give it this:"),
  );
  context.write("");
  context.write(prompt);
  context.write("");
  context.write(
    dim(
      `  Print it again: barndog hooks adapt ${name} --origin ${LOCAL_ORIGIN}`,
    ),
  );
}

export async function addHook(
  url: string,
  options: AddOptions,
  context: AddContext,
) {
  assertSourceExists(url);
  if (await plainFolder(url))
    throw new CliError(
      `${url} isn't a Git repo, and Hooks can only be added from one for now.`,
      "git init, commit the Hook, then run barndog hooks add again",
    );
  const location = parseLocation(url);
  const fallback =
    slugify(basename(url.replace(/\/$/, "").replace(/\.git$/, ""))) || "hook";
  await fetchRemote(location, { allowPrompt: true }, async (remote) => {
    const { candidates, skipped } = discoverHooks(remote, fallback);
    for (const skip of skipped)
      context.write(`${warn("!")} ${skip.path}: ${skip.reason}`);
    let [candidate] = candidates;
    if (!candidate) throw notFound(remote, url, "Hook");
    const wanted = only(options.only ?? []);
    if (candidates.length > 1) {
      if (wanted)
        candidate = candidates.find((c) => c.name === wanted) ?? candidate;
      else if (!context.interactive)
        throw new CliError(
          `${url} has several Hooks: ${candidates.map((c) => c.name).join(", ")}.`,
          "barndog hooks add <url> --only <name>",
        );
      else {
        const picked = await context.prompts.chooseOne(
          "Which Hook do you want?",
          candidates.map((c, index) => ({
            name:
              c.type === "package"
                ? `${c.name}  ${dim(folderLabel(c.root))}`
                : c.name,
            value: String(index),
            ...(c.type === "package"
              ? { description: `Description: ${c.description}` }
              : {}),
          })),
        );
        candidate = candidates[Number(picked)] ?? candidate;
      }
    }
    const mode = await updateMode(options, context);
    if (candidate.type === "package") {
      const name = options.as ?? candidate.name;
      const entries = candidate.entries.map((entry) =>
        entry.path === "hook.yaml" && name !== candidate.name
          ? {
              ...entry,
              data: Buffer.from(setYamlName(entry.data.toString("utf8"), name)),
            }
          : entry,
      );
      const saved = await saveImported(
        { kind: "hook", name, entries, mode, remote, root: candidate.root },
        context.home,
      );
      context.write(`${ok("✔")} Added ${bold(name)}`);
      await reportCoverage(name, saved.path, context);
      return;
    }
    const modes = new Map(remote.snapshot.entries.map((e) => [e.path, e.mode]));
    const executable = (script: string) => modes.get(script) === "100755";
    // Settings the author shipped answer every question, and no other tool is offered.
    const written = harnesses.filter(
      (h) => candidate.implementations[h]?.length,
    );
    let plan: Partial<Record<Harness, DraftEvent[]>>;
    if (written.length) {
      const chosen =
        context.interactive && written.length > 1
          ? (
              await context.prompts.chooseMany(
                "Which coding tools should this Hook support?",
                written.map((h) => ({
                  name: `${adapters[h].name}  ${dim(`found in this ${remote.path ? "folder" : "repo"}`)}`,
                  short: adapters[h].name,
                  value: h,
                  checked: true,
                })),
              )
            ).filter(isHarness)
          : written;
      const { implementations } = candidate;
      plan = Object.fromEntries(
        chosen.map((h) => [h, implementations[h] ?? []]),
      );
    } else if (context.interactive)
      plan = await pickHookPlan(candidate, executable, context);
    else
      throw new CliError(
        "These scripts need events chosen for each coding tool. Run this in a terminal to choose them.",
      );
    if (!Object.values(plan).some((events) => events?.length))
      throw new CliError("No events were chosen, so nothing was added.");
    const name =
      options.as ??
      (context.interactive
        ? (await context.prompts.text("Hook name", candidate.name)).trim()
        : candidate.name);
    const description =
      options.description ??
      (context.interactive
        ? (
            await context.prompts.text(
              "What does it do?",
              `Hook from ${remote.url}`,
            )
          ).trim()
        : `Hook from ${remote.url}`);
    const built = buildHookPackage(remote, {
      name,
      description,
      implementations: plan,
    });
    context.write(dim("These commands will run on this machine:"));
    for (const [harness, events] of Object.entries(plan))
      for (const event of events ?? [])
        context.write(
          dim(
            `  ${harness}  ${event.event}${event.matcher ? ` (${event.matcher})` : ""}  ${event.script}`,
          ),
        );
    if (context.interactive && !(await context.prompts.yes("Add this Hook?")))
      throw new CliError("Nothing was added.");
    const saved = await saveImported(
      {
        kind: "hook",
        name,
        entries: built.entries,
        mode,
        remote,
        root: built.root,
        files: built.files,
      },
      context.home,
    );
    context.write(`${ok("✔")} Added ${bold(name)}`);
    if (plan.codex?.length)
      context.write(
        dim("Codex skips new Hooks until you trust them with /hooks."),
      );
    // Scripts placed by hand were given their tools on purpose.
    if (written.length) await reportCoverage(name, saved.path, context);
  });
  await finish(context);
}

async function serversToAdd(
  name: string | undefined,
  options: AddOptions,
  context: AddContext,
): Promise<ImportedServer[]> {
  if (options.config) return parseMcpText(options.config, name);
  if (options.file)
    return parseMcpText(await readFile(options.file, "utf8"), name);
  const fromHarness = async () => {
    const all = (await harnessServers(context.home)).filter(
      (s) => !options.from || s.harness === options.from,
    );
    const matching = name ? all.filter((s) => s.name === name) : all;
    if (!matching.length)
      throw new CliError(
        name
          ? `No MCP server named ${name} in your coding tools.`
          : "No MCP servers found in your coding tools that BarnDog doesn't already manage.",
      );
    if (name && matching.length === 1) return matching;
    if (!context.interactive)
      throw new CliError(
        `Several servers match: ${matching.map((s) => `${s.name} (${s.label})`).join(", ")}.`,
        "barndog mcp add <name> --from <harness>",
      );
    const picked = await context.prompts.chooseMany(
      "Which MCP servers do you want to add?",
      matching.map((s, i) => ({
        name: `${s.name}  ${dim(s.label)}`,
        value: String(i),
      })),
    );
    return picked.flatMap((i) => matching[Number(i)] ?? []);
  };
  if (options.from) return fromHarness();
  if (!context.interactive) {
    if (process.stdin.isTTY)
      throw new CliError(
        "Pass the configuration with --config, --file or --from, or pipe it in.",
        "barndog mcp add --file <path>",
      );
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    return parseMcpText(text, name);
  }
  const source = await context.prompts.chooseOne("Where's the configuration?", [
    { name: "Paste JSON", value: "paste" },
    { name: "One of my coding tools", value: "harness" },
  ]);
  return source === "paste"
    ? parseMcpText(await context.prompts.paste(), name)
    : fromHarness();
}

export async function addMcp(
  name: string | undefined,
  options: AddOptions,
  context: AddContext,
) {
  // `--json` is the global output flag, so this catches the old spelling.
  if (name?.trimStart().startsWith("{"))
    throw new CliError(
      "That looks like the configuration, not a name.",
      "barndog mcp add <name> --config '<json>'",
    );
  const imported = await serversToAdd(name, options, context);
  const oauth = new Set<string>();
  for (const { name: server, server: raw } of imported)
    if (
      options.oauth ||
      (context.interactive &&
        (raw.url || raw.httpUrl) &&
        !raw.headers &&
        !raw.http_headers &&
        !raw.env_http_headers &&
        !raw.bearer_token_env_var &&
        (await context.prompts.yes(
          `Does ${server} sign in through a browser (OAuth)?`,
          false,
        )))
    )
      oauth.add(server);
  const servers = imported.map((server) =>
    convertServer(server, options.description, oauth.has(server.name)),
  );
  if (!servers.length)
    throw new CliError("No MCP servers were chosen, so nothing was added.");
  let replace = options.replace;
  const conflicts = (
    await Promise.all(
      servers.map((s) => conflictingEntries(s.name, context.home)),
    )
  ).flat();
  if (conflicts.length && !replace && context.interactive) {
    context.write(
      "These entries will be replaced by BarnDog-managed ones. A backup of each file is kept:",
    );
    for (const conflict of conflicts) context.write(dim(`  ${conflict.file}`));
    replace = await context.prompts.yes("Replace them?");
    if (!replace) throw new CliError("Nothing was added.");
  }
  const result = await addMcpServers(servers, { replace }, context.home);
  for (const added of result.added)
    context.write(`${ok("✔")} Added ${bold(added)}`);
  for (const note of result.notes) context.write(`${warn("!")} ${note}`);
  for (const backup of result.backups) context.write(dim(`Backup: ${backup}`));
}
