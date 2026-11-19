/**
 * Finds the Skills, MCP servers and Hooks the user set up in each selected
 * coding tool themselves, leaving out everything `state.json` says BarnDog
 * installed. Nothing here changes a file.
 */
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  hookImplementationSchema,
  type HookManifest,
  type McpDefinition,
} from "@barndog-ai/api-contract";
import {
  hookMetadata,
  packageFingerprint,
  validatePackageEntries,
  type PackageEntry,
} from "@barndog-ai/api-contract/package";
import { parse as parseJsonc } from "jsonc-parser";
import { stringify } from "yaml";

import { readSettings, SetupRequiredError } from "../../config/settings.js";
import { readState, type State } from "../../config/state.js";
import { CliError, friendlyMessage } from "../../errors.js";
import {
  adapters,
  hookHarnesses,
  nativeFile,
  skillDirectory,
  type Harness,
  type HookHarness,
} from "../../harnesses/registry.js";
import { isWindows } from "../../platform.js";
import type { RuntimeContext } from "../../runtime.js";
import { ifExists, readIfExists } from "../../shared/files.js";
import { slugify, validAssetName } from "../../shared/patterns.js";
import { asRecord, isRecord } from "../../shared/values.js";
import { discoverSkills, ROOT_TOKEN } from "../imports/discover.js";
import { readFolder } from "../imports/folder.js";
import { renamedSkill } from "../imports/local.js";
import { convertServer, harnessServers } from "../mcps/import.js";
import { assetKinds } from "../asset-kinds/index.js";
import { assetPath, NAME_RULE } from "../workspace/format.js";
import { localMcpNamed, type LiteralValue } from "../mcps/import.js";
import type { NativeAssetKind, Original } from "./record.js";

/** One asset a coding tool has that BarnDog didn't install. */
export type NativeAsset = {
  /** `claude/mcp/github`: how `--only` names it. */
  key: string;
  harness: Harness;
  kind: NativeAssetKind;
  name: string;
  description: string;
  /** The folder or settings file it lives in. */
  location: string;
  /**
   * Other tools' Skills or MCP servers with this name. BarnDog installs one
   * copy in every tool it manages, so adopting one takes these over too.
   */
  sameName: AssetRef[];
  /** Whether every asset in `sameName` is identical to this one. */
  identical: boolean;
  /** What changes once BarnDog manages it, such as a variable to set. */
  notes: string[];
  /**
   * An MCP server's values that were written into its entry, by variable name
   * only: adopting asks whether BarnDog keeps each on this machine.
   */
  values: { key: string; variable: string }[];
};

/** Another tool's asset, by key and tool. */
export type AssetRef = { key: string; harness: Harness };

/** Something that looks like an asset but can't be adopted, and why. */
type SkippedAsset = {
  harness: Harness;
  kind: NativeAssetKind;
  name: string;
  location: string;
  reason: string;
};

export type NativeScan = { assets: NativeAsset[]; skipped: SkippedAsset[] };

/** What BarnDog writes into its local folder for an adopted asset. */
type AdoptedContent =
  | { kind: "skill" | "hook"; entries: PackageEntry[] }
  | { kind: "mcp"; definition: McpDefinition };

/** A scanned asset with what adopting it writes and removes. */
export type FoundAsset = NativeAsset & {
  /** The values themselves; kept in memory, never shown or recorded. */
  literals: LiteralValue[];
  content: AdoptedContent;
  original: Original;
  /** Where its copy goes inside the local folder, such as `org/mcp/github.yaml`. */
  copy: string;
};

type Found = { found: FoundAsset[]; skipped: SkippedAsset[] };

/** An asset before cross-tool comparison fills in `sameName` and `identical`. */
type Candidate = Omit<FoundAsset, "key" | "sameName" | "identical" | "copy">;

/** What can be adopted, without the file contents. */
export async function scanNative(runtime: RuntimeContext): Promise<NativeScan> {
  const { found, skipped } = await findNativeAssets(runtime);

  return { assets: found.map(publicAsset), skipped };
}

const publicAsset = (asset: FoundAsset): NativeAsset => ({
  key: asset.key,
  harness: asset.harness,
  kind: asset.kind,
  name: asset.name,
  description: asset.description,
  location: asset.location,
  sameName: asset.sameName,
  identical: asset.identical,
  notes: asset.notes,
  values: asset.values,
});

/** Every adoptable asset in the selected tools, with its contents. */
export async function findNativeAssets(
  runtime: RuntimeContext,
): Promise<Found> {
  const { home } = runtime;

  const settings = await readSettings(home);
  if (!settings) {
    throw new SetupRequiredError();
  }

  const state = await readState(home);
  const selected = settings.harnesses;
  const local = settings.localWorkspace?.path;
  /** The local asset a candidate's name collides with; for an MCP server, ignoring case. */
  const taken = async (kind: NativeAssetKind, name: string) => {
    if (kind === "mcp") {
      return localMcpNamed(name, runtime);
    }

    const path = local && join(local, assetPath("org", kind, name));

    return path && (await ifExists(lstat(path))) !== null ? name : null;
  };

  const skipped: SkippedAsset[] = [];
  const candidates: Candidate[] = [];

  for (const harness of selected) {
    const skills = await toolSkills(harness, state, runtime);
    candidates.push(...skills.found);
    skipped.push(...skills.skipped);
  }

  const servers = await toolServers(selected, runtime);
  candidates.push(...servers.found);
  skipped.push(...servers.skipped);

  for (const harness of hookHarnesses) {
    if (selected.includes(harness)) {
      const hooks = await toolHooks(harness, state, runtime);
      candidates.push(...hooks.found);
      skipped.push(...hooks.skipped);
    }
  }

  // Skill and MCP names come from the tool and can't change; a Hook's name is
  // made up here, so it moves aside instead.
  const kept: Candidate[] = [];
  for (const candidate of candidates) {
    const existing =
      candidate.kind === "hook"
        ? null
        : await taken(candidate.kind, candidate.name);

    if (existing !== null) {
      skipped.push({
        ...describe(candidate),
        reason:
          existing === candidate.name
            ? `Your local folder already has ${assetKinds[candidate.kind].a} named ${candidate.name}.`
            : `Your local folder has ${existing}, which differs only in case and would share its file on this disk.`,
      });
    } else {
      kept.push(candidate);
    }
  }

  const hookNames = new Set<string>();
  for (const candidate of kept.filter((c) => c.kind === "hook")) {
    let name = candidate.name;
    for (
      let suffix = 2;
      hookNames.has(name) || (await taken("hook", name));
      suffix++
    ) {
      name = `${candidate.name}-${suffix}`;
    }

    hookNames.add(name);
    if (name !== candidate.name && candidate.content.kind === "hook") {
      candidate.content = {
        kind: "hook",
        entries: renameHook(candidate.content.entries, name),
      };

      candidate.name = name;
    }
  }

  return { found: compare(kept), skipped };
}

const describe = (asset: Candidate): Omit<SkippedAsset, "reason"> => ({
  harness: asset.harness,
  kind: asset.kind,
  name: asset.name,
  location: asset.location,
});

/** Fills in which other tools have an asset of the same kind and name, and whether it matches. */
function compare(candidates: Candidate[]): FoundAsset[] {
  return candidates.map((candidate) => {
    const others =
      candidate.kind === "hook"
        ? []
        : candidates.filter(
            (other) =>
              other !== candidate &&
              other.kind === candidate.kind &&
              other.name === candidate.name,
          );

    return {
      ...candidate,
      key: assetKey(candidate),
      copy: assetPath("org", candidate.kind, candidate.name),
      sameName: others.map((other) => ({
        key: assetKey(other),
        harness: other.harness,
      })),
      identical: others.every((other) =>
        sameContent(other.content, candidate.content),
      ),
    };
  });
}

const assetKey = (asset: Pick<NativeAsset, "harness" | "kind" | "name">) =>
  `${asset.harness}/${asset.kind}/${asset.name}`;

function sameContent(left: AdoptedContent, right: AdoptedContent) {
  if (left.kind === "mcp" || right.kind === "mcp") {
    return (
      left.kind === "mcp" &&
      right.kind === "mcp" &&
      isDeepStrictEqual(left.definition, right.definition)
    );
  }

  return packageFingerprint(left.entries) === packageFingerprint(right.entries);
}

/** Skill folders in one tool's Skill directory, followed through links the user made. */
async function toolSkills(
  harness: Harness,
  state: State,
  runtime: RuntimeContext,
) {
  const directory = skillDirectory(harness, runtime.home);
  const owned = new Set(
    state.links
      .filter((link) => link.harness === harness)
      .map((link) => resolve(link.target)),
  );

  const found: Candidate[] = [];
  const skipped: SkippedAsset[] = [];
  const names = (await ifExists(readdir(directory))) ?? [];

  for (const name of names.sort()) {
    const path = join(directory, name);
    // Hidden folders hold the tool's own Skills, such as Codex's `.system`.
    if (name.startsWith(".") || owned.has(resolve(path))) {
      continue;
    }

    const skill = await readSkill({ harness, name, path }, runtime);
    if (skill && "reason" in skill) {
      skipped.push(skill);
    } else if (skill) {
      found.push(skill);
    }
  }

  return { found, skipped };
}

/** One entry of a Skill directory: a Skill, why it can't be adopted, or null when it isn't a Skill. */
async function readSkill(
  entry: { harness: Harness; name: string; path: string },
  runtime: RuntimeContext,
): Promise<Candidate | SkippedAsset | null> {
  const { name, path } = entry;
  const where = {
    harness: entry.harness,
    kind: "skill" as const,
    name,
    location: path,
  };

  const link = (await lstat(path)).isSymbolicLink()
    ? await readlink(path)
    : null;

  const folder = link === null ? path : await ifExists(realpath(path));
  if (folder === null) {
    return {
      ...where,
      reason: `It links to ${link ?? path}, which doesn't exist.`,
    };
  }

  if (
    !(await lstat(folder)).isDirectory() ||
    (await ifExists(lstat(join(folder, "SKILL.md")))) === null
  ) {
    return null;
  }

  if (!validAssetName(name)) {
    return {
      ...where,
      reason: `${name} can't be a BarnDog name. ${NAME_RULE}.`,
    };
  }

  const { skills, skipped } = discoverSkills(await readFolder(folder, runtime));
  const skill = skills.find((candidate) => candidate.root === "");
  if (!skill) {
    return {
      ...where,
      reason:
        skipped.find((problem) => problem.path === "SKILL.md")?.reason ??
        "It isn't a valid Skill.",
    };
  }

  return {
    ...where,
    description: skill.description,
    notes: [],
    literals: [],
    values: [],
    content: { kind: "skill", entries: renamedSkill(skill, name) },
    original:
      link === null
        ? { type: "folder", path }
        : { type: "link", path, target: link },
  };
}

/** MCP servers configured for the whole user, not for one project. */
async function toolServers(
  selected: readonly Harness[],
  runtime: RuntimeContext,
) {
  const found: Candidate[] = [];
  const skipped: SkippedAsset[] = [];

  for (const server of await harnessServers(runtime)) {
    if (
      !selected.includes(server.harness) ||
      server.label.includes("project")
    ) {
      continue;
    }

    const asset = {
      harness: server.harness,
      kind: "mcp" as const,
      name: server.name,
      location: server.file,
    };

    if (!assetKinds.mcp.validName(server.name)) {
      skipped.push({
        ...asset,
        reason: `${server.name} can't be a BarnDog name. ${assetKinds.mcp.nameRule}.`,
      });

      continue;
    }

    // OpenCode reads several files; one name in two of them is two servers.
    const twice = found.find(
      (other) => other.harness === server.harness && other.name === server.name,
    );

    if (twice) {
      skipped.push({
        ...asset,
        reason: `${twice.location} also configures ${server.name}.`,
      });

      continue;
    }

    try {
      const converted = convertServer(server);
      found.push({
        ...asset,
        description: converted.definition.description,
        notes: converted.notes,
        literals: converted.literals,
        values: converted.literals.map(({ key, variable }) => ({
          key,
          variable,
        })),
        content: { kind: "mcp", definition: converted.definition },
        original: {
          type: "entry",
          kind: "mcp",
          file: server.file,
          key: server.name,
          value: server.native,
        },
      });
    } catch (error) {
      skipped.push({ ...asset, reason: friendlyMessage(error) });
    }
  }

  return { found, skipped };
}

/** One element of a hook event's list in a tool's settings file. */
type NativeGroup = Record<string, unknown>;

/** The hook entries in one tool's user settings file, one Hook per event entry. */
async function toolHooks(
  harness: HookHarness,
  state: State,
  runtime: RuntimeContext,
) {
  const file = nativeFile(harness, "hook", runtime.home);
  const found: Candidate[] = [];
  const skipped: SkippedAsset[] = [];

  const text = await readIfExists(file);
  if (text === null) {
    return { found, skipped };
  }

  const owned = state.native.filter(
    (entry) => entry.harness === harness && entry.file === file,
  );

  for (const [event, groups] of Object.entries(
    asRecord(asRecord(parseJsonc(text)).hooks),
  )) {
    if (!Array.isArray(groups)) {
      continue;
    }

    for (const group of groups.filter(isRecord)) {
      if (
        owned.some(
          (entry) =>
            entry.key === event && isDeepStrictEqual(entry.value, group),
        )
      ) {
        continue;
      }

      const where = { harness, kind: "hook" as const, location: file };
      const label = `${event} hook`;
      // Undo and adoption find an entry by its value, so it must be unique.
      if (
        groups.filter((other) => isDeepStrictEqual(other, group)).length > 1
      ) {
        skipped.push({
          ...where,
          name: label,
          reason: `${file} lists the same ${event} hook twice. Remove one copy first.`,
        });

        continue;
      }

      try {
        const hook = await hookPackage({ harness, event, group }, runtime);

        found.push({
          ...where,
          name: hook.name,
          description: hook.description,
          notes: hook.notes,
          literals: [],
          values: [],
          content: { kind: "hook", entries: hook.entries },
          original: {
            type: "entry",
            kind: "hook",
            file,
            key: event,
            value: group,
          },
        });
      } catch (error) {
        skipped.push({ ...where, name: label, reason: friendlyMessage(error) });
      }
    }
  }

  return { found, skipped };
}

/** The parts of a native hook command that may name a script file. */
type PathWord = { word: string; path: string };

/**
 * The absolute paths a hook command line mentions, with the word each came
 * from: `"$HOME/.claude/hooks/x.sh" --fix` → `$HOME/.claude/hooks/x.sh` as
 * `<home>/.claude/hooks/x.sh`. `~/`, `$HOME/` and `${HOME}/` count as the home
 * folder; relative paths name nothing, since the tool's working folder varies.
 *
 * @internal Exported for its table test in `src/tests/patterns.test.ts`.
 */
export function commandPaths(command: string, home: string): PathWord[] {
  const words: PathWord[] = [];
  for (const raw of command.split(" ")) {
    const quote = raw.at(0);
    const word =
      raw.length > 1 && (quote === '"' || quote === "'") && raw.endsWith(quote)
        ? raw.slice(1, -1)
        : raw;

    const prefix = ["~/", "$HOME/", "${HOME}/"].find((p) => word.startsWith(p));
    const path = prefix ? join(home, word.slice(prefix.length)) : word;
    if (path && isAbsolute(path)) {
      words.push({ word, path });
    }
  }

  return words;
}

/** The first script a command runs, copied into the package, and the command pointed at it. */
async function packagedCommand(
  command: string,
  scriptName: string,
  runtime: RuntimeContext,
) {
  for (const { word, path } of commandPaths(command, runtime.home)) {
    const info = await ifExists(lstat(path));
    if (info?.isFile()) {
      const file = basename(path);

      return {
        command: command.replace(word, () => `${ROOT_TOKEN}/${file}`),
        script: { path: file, data: await readFile(path) },
        from: path,
      };
    }
  }

  // A command with no script file becomes one; that needs a POSIX shell.
  if (isWindows(runtime.platform)) {
    throw new CliError(
      `"${command}" doesn't run a script file, and on Windows BarnDog only adopts hooks that do.`,
    );
  }

  return {
    command: `${ROOT_TOKEN}/${scriptName}`,
    script: {
      path: scriptName,
      data: Buffer.from(`#!/bin/sh\n${command}\n`),
    },
    from: undefined,
  };
}

/**
 * Hook names are made from a script's name; this leaves room for a `-2`
 * suffix within the 64-character asset name limit.
 */
const HOOK_NAME_LENGTH = 60;

/** Each command handler pointed at a script inside the package. */
async function packageHandlers(
  handlers: unknown[],
  event: string,
  runtime: RuntimeContext,
) {
  const scripts = new Map<string, Buffer>();
  const copied: string[] = [];
  const rewritten: Record<string, unknown>[] = [];
  for (const [index, handler] of handlers.entries()) {
    if (
      !isRecord(handler) ||
      typeof handler.command !== "string" ||
      (handler.type ?? "command") !== "command"
    ) {
      const type = asRecord(handler).type;

      throw new CliError(
        `It runs a ${typeof type === "string" ? type : "non-command"} hook, and BarnDog adopts only command hooks.`,
      );
    }

    const packaged = await packagedCommand(
      handler.command,
      `${slugify(event) || "hook"}-${index + 1}.sh`,
      runtime,
    );

    const already = scripts.get(packaged.script.path);
    if (already && !already.equals(packaged.script.data)) {
      throw new CliError(
        `It runs two different scripts named ${packaged.script.path}.`,
      );
    }

    scripts.set(packaged.script.path, packaged.script.data);
    if (packaged.from) {
      copied.push(packaged.from);
    }

    rewritten.push({ ...handler, command: packaged.command });
  }

  return { scripts, copied, rewritten };
}

/** A Hook package that runs what one native hook entry ran. */
async function hookPackage(
  input: {
    harness: HookHarness;
    event: string;
    group: NativeGroup;
  },
  runtime: RuntimeContext,
) {
  const { harness, event, group } = input;
  const nested = Array.isArray(group.hooks);
  const { scripts, copied, rewritten } = await packageHandlers(
    Array.isArray(group.hooks) ? group.hooks : [group],
    event,
    runtime,
  );

  // Named after the script it runs, else after its event.
  const [script] = copied;
  const name =
    slugify(script ? basename(script, extname(script)) : event).slice(
      0,
      HOOK_NAME_LENGTH,
    ) || "hook";

  // The home-relative path, since a description may be shared beyond this machine.
  const description = `${adapters[harness].name} ${event} hook from ~/${adapters[harness].hooks.file}`;
  const events = hookImplementationSchema.shape.events.safeParse({
    [event]: [nested ? { ...group, hooks: rewritten } : rewritten[0]],
  });

  if (!events.success) {
    throw new CliError(
      `It uses settings a BarnDog Hook can't hold: ${events.error.issues.map((issue) => issue.path.join(".")).join(", ")}.`,
    );
  }

  const manifest: HookManifest = {
    name,
    description,
    implementations: {
      [harness]: {
        compatibility: "supported",
        scripts: [...scripts.keys()],
        requirements: { commands: [] },
        events: events.data,
      },
    },
  };

  const entries = hookEntries(manifest, scripts);

  return {
    name,
    description,
    entries,
    notes: copied.map(
      (path) =>
        `BarnDog runs its own copy of ${path}. The original stays, but edits to it no longer reach this hook.`,
    ),
  };
}

function hookEntries(manifest: HookManifest, scripts: Map<string, Buffer>) {
  const entries: PackageEntry[] = [
    ...[...scripts].map(([path, data]) => ({ path, data, executable: true })),
    {
      path: "hook.yaml",
      data: Buffer.from(stringify(manifest)),
      executable: false,
    },
  ];

  hookMetadata(validatePackageEntries(entries, undefined, "hook.yaml"));

  return entries;
}

/** The same Hook package under another name, for when the first choice is taken. */
function renameHook(entries: PackageEntry[], name: string): PackageEntry[] {
  const scripts = new Map<string, Buffer>();
  let manifest: HookManifest | undefined;
  for (const entry of entries) {
    if (entry.path === "hook.yaml") {
      manifest = hookMetadata(entries);
    } else {
      scripts.set(entry.path, entry.data);
    }
  }

  if (!manifest) {
    throw new Error("An adopted Hook package has no hook.yaml");
  }

  return hookEntries({ ...manifest, name }, scripts);
}
