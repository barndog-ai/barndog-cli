/** `barndog hooks add`: brings Hooks from a repository into the local workspace. */
import { GIT_MODE } from "../features/workspace/snapshot.js";
import { basename } from "node:path";
import { CliError } from "../errors.js";
import { readSettings } from "../config/settings.js";
import {
  adapters,
  hookHarnesses,
  type HookHarness,
  isHookHarness,
} from "../harnesses/registry.js";
import {
  buildHookPackage,
  discoverHooks,
  plainCommand,
  type DraftEvent,
  type HookCandidate,
} from "../features/imports/discover.js";
import { adaptHook, toolNames } from "../features/hooks/adapt.js";
import { folderDivergence } from "../features/hooks/divergence.js";
import { LOCAL_ORIGIN } from "../features/workspace/overlay.js";
import { saveImported } from "../features/imports/local.js";
import { assertSourceExists, plainFolder } from "../features/imports/folder.js";
import { fetchRemote, parseLocation } from "../features/imports/remote.js";
import { bold, choiceDescription, dim, ok, warn } from "./format.js";
import { setYamlName, slugify } from "../shared/patterns.js";
import { only } from "../shared/lookup.js";
import {
  assertDistinctNames,
  finish,
  folderLabel,
  notFound,
  onlyChosen,
  type AddContext,
  type AddOptions,
  updateMode,
} from "./add-asset.js";

/** Scripts with no settings anywhere: the person says which tools and events run them. */
async function pickHookPlan(
  draft: Extract<HookCandidate, { type: "draft" }>,
  executable: (script: string) => boolean,
  context: AddContext,
) {
  const { prompts } = context;
  // Choices made for one coding tool start out selected for the next.
  const carried = new Map<string, DraftEvent>();
  const managed = (await readSettings(context.runtime.home))?.harnesses ?? [];
  const chosen = (
    await prompts.chooseMany(
      "Which coding tools should this Hook support?",
      hookHarnesses.map((h) => ({
        name: adapters[h].name,
        value: h,
        checked: managed.includes(h),
      })),
    )
  ).filter(isHookHarness);

  const plan: Partial<Record<HookHarness, DraftEvent[]>> = {};
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

    if (drafts.length) {
      plan[harness] = drafts;
    }
  }

  return plan;
}

type HookPackage = Extract<HookCandidate, { type: "package" }>;

/** The packaged Hooks to add: named by `--only`, all of them, or ticked in a picker. */
async function choosePackages(
  packages: HookPackage[],
  url: string,
  options: AddOptions,
  context: AddContext,
): Promise<HookPackage[]> {
  let chosen = packages;
  if (options.only?.length) {
    chosen = onlyChosen(packages, options.only, { url, kind: "hook" });
  } else if (packages.length > 1 && !options.all) {
    if (!context.interactive) {
      throw new CliError(
        `${url} has ${packages.length} Hooks: ${packages.map((p) => p.name).join(", ")}.`,
        `barndog hooks add ${url} --only <name>`,
      );
    }

    const picked = await context.prompts.chooseMany(
      "Which Hooks do you want?",
      packages.map((p) => ({
        name: `${p.name}  ${dim(folderLabel(p.root))}`,
        value: p.root,
        short: p.name,
        description: choiceDescription(`Description: ${p.description}`),
      })),
    );

    chosen = packages.filter((p) => picked.includes(p.root));
  }

  if (!chosen.length) {
    throw new CliError("No Hooks were chosen, so nothing was added.");
  }

  assertDistinctNames(chosen, { url, kind: "hook" });
  if (options.as && chosen.length !== 1) {
    throw new CliError("--as renames one Hook, so choose exactly one.");
  }

  return chosen;
}

/** Says which of this machine's coding tools a new Hook leaves out, with one prompt for all. */
async function reportCoverage(
  name: string,
  folder: string,
  context: AddContext,
) {
  const divergence = await folderDivergence(folder);
  if (divergence) {
    context.write(`${warn("!")} ${divergence}`);
  }

  const { written, targets, prompt } = await adaptHook(
    name,
    LOCAL_ORIGIN,
    undefined,
    context.runtime,
  );

  if (!prompt) {
    return;
  }

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

/**
 * `hooks add <url>`: copies a Hook package, or a draft built from harness
 * settings, into the local workspace.
 */
export async function addHook(
  url: string,
  options: AddOptions,
  context: AddContext,
) {
  assertSourceExists(url, context.runtime);
  if (await plainFolder(url, context.runtime)) {
    throw new CliError(
      `${url} isn't a Git repo, and Hooks can only be added from one for now.`,
      "git init, commit the Hook, then run barndog hooks add again",
    );
  }

  const location = parseLocation(url);
  const fallback =
    slugify(basename(url.replace(/\/$/, "").replace(/\.git$/, ""))) || "hook";

  await fetchRemote(
    location,
    { allowPrompt: context.interactive },
    async (remote) => {
      const { candidates, skipped } = discoverHooks(remote, fallback);
      for (const skip of skipped) {
        context.write(`${warn("!")} ${skip.path}: ${skip.reason}`);
      }

      const packages = candidates.flatMap((c) =>
        c.type === "package" ? [c] : [],
      );

      if (packages.length) {
        const chosen = await choosePackages(packages, url, options, context);
        const mode = await updateMode(options, context);
        for (const candidate of chosen) {
          const name = options.as ?? candidate.name;
          const entries = candidate.entries.map((entry) =>
            entry.path === "hook.yaml" && name !== candidate.name
              ? {
                  ...entry,
                  data: Buffer.from(
                    setYamlName(entry.data.toString("utf8"), name),
                  ),
                }
              : entry,
          );

          const saved = await saveImported(
            { kind: "hook", name, entries, mode, remote, root: candidate.root },
            context.runtime,
          );

          context.write(`${ok("✔")} Added ${bold(name)}`);
          await reportCoverage(name, saved.path, context);
        }

        return;
      }

      const [candidate] = candidates.flatMap((c) =>
        c.type === "draft" ? [c] : [],
      );

      if (!candidate) {
        throw notFound(remote, url, "Hook");
      }

      // A draft is built from loose scripts and settings, so it has no name to choose by.
      if (options.only?.length) {
        throw new CliError(
          `${url} has no packaged Hooks to choose from, only scripts and settings to build one from.`,
          `barndog hooks add ${url}`,
        );
      }

      const mode = await updateMode(options, context);

      const modes = new Map(
        remote.snapshot.entries.map((e) => [e.path, e.mode]),
      );

      const executable = (script: string) =>
        modes.get(script) === GIT_MODE.executable;

      // Settings the author shipped answer every question, and no other tool is offered.
      const written = hookHarnesses.filter(
        (h) => candidate.implementations[h]?.length,
      );

      let plan: Partial<Record<HookHarness, DraftEvent[]>>;
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
              ).filter(isHookHarness)
            : written;

        const { implementations } = candidate;
        plan = Object.fromEntries(
          chosen.map((h) => [h, implementations[h] ?? []]),
        );
      } else if (context.interactive) {
        plan = await pickHookPlan(candidate, executable, context);
      } else {
        throw new CliError(
          "These scripts need events chosen for each coding tool. Run this in a terminal to choose them.",
        );
      }

      if (!Object.values(plan).some((events) => events?.length)) {
        throw new CliError("No events were chosen, so nothing was added.");
      }

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
      for (const [harness, events] of Object.entries(plan)) {
        for (const event of events ?? []) {
          context.write(
            dim(
              `  ${harness}  ${event.event}${event.matcher ? ` (${event.matcher})` : ""}  ${event.script}`,
            ),
          );
        }
      }

      if (
        context.interactive &&
        !(await context.prompts.yes("Add this Hook?"))
      ) {
        throw new CliError("Nothing was added.");
      }

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
        context.runtime,
      );

      context.write(`${ok("✔")} Added ${bold(name)}`);
      for (const harness of hookHarnesses) {
        const { trustNote } = adapters[harness].hooks;
        if (trustNote && plan[harness]?.length) {
          context.write(dim(trustNote));
        }
      }

      // Scripts placed by hand were given their tools on purpose.
      if (written.length) {
        await reportCoverage(name, saved.path, context);
      }
    },
    context.runtime,
  );

  await finish(context);
}
