import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  packageFingerprint,
  writePackage,
  type PackageEntry,
} from "@barndog-ai/api-contract/package";
import {
  diffEntries,
  readDirectory,
} from "@barndog-ai/api-contract/collaboration";

import { selectionState, withSelection } from "../../config/environment.js";
import {
  readSettings,
  saveSettings,
  settingsPath,
  SetupRequiredError,
  upgradeSettings,
  type LocalWorkspace,
  type Settings,
} from "../../config/settings.js";
import { CliError, friendlyMessage, errorCode } from "../../errors.js";
import { renameSkillEntries } from "../environment/installed.js";
import {
  assertAssetName,
  assetPath,
  validAssetName,
} from "../git-workspace/format.js";
import { withLocalSubscription } from "../git-workspace/overlay.js";
import { localWorkspace } from "../git-workspace/setup.js";
import { localRepoSource } from "../git-workspace/source.js";
import {
  discoverSkills,
  folderEntries,
  type SkillCandidate,
} from "./discover.js";
import { readFolder } from "./folder.js";
import { fetchRemote, type RemoteRepo } from "./remote.js";
import {
  assetKinds,
  packageKindList,
  type PackageKind,
} from "../asset-kinds/index.js";
import { defined } from "../../shared/lookup.js";
import { z } from "zod";

const SOURCES_FILE = ".barndog-sources.json";

export type UpdateMode = "fork" | "manual" | "auto";

const importRecordSchema = z.looseObject({
  kind: z.enum(packageKindList),
  name: z.string(),
  mode: z.enum(["manual", "auto"]),
  url: z.string(),
  ref: z.string().nullable(),
  root: z.string(),
  commit: z.string(),
  /** Set for Hooks built by the picker: only these files come from the repo. */
  files: z.array(z.string()).optional(),
  fingerprint: z.string(),
});

type ImportRecord = z.infer<typeof importRecordSchema>;

const sourcesSchema = z.looseObject({
  checkedAt: z.string().optional(),
  imports: z.array(importRecordSchema),
});

type Sources = z.infer<typeof sourcesSchema>;

async function readSources(folder: string): Promise<Sources> {
  try {
    return sourcesSchema.parse(
      JSON.parse(await readFile(join(folder, SOURCES_FILE), "utf8")),
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { imports: [] };
    throw error;
  }
}

const writeSources = (folder: string, sources: Sources) =>
  writeFile(
    join(folder, SOURCES_FILE),
    JSON.stringify(sources, null, 2) + "\n",
  );

/** The repository an asset still follows, or null for a fork or one made here. */
export async function importedFrom(
  kind: "skill" | "hook",
  name: string,
  home = homedir(),
) {
  const settings = await readSettings(home);
  if (settings?.version !== 2 || !settings.localWorkspace) return null;
  const { imports } = await readSources(settings.localWorkspace.path);
  return imports.find((e) => e.kind === kind && e.name === name) ?? null;
}

/** Adding always lands in the local folder, creating it on first use. */
export async function ensureLocalWorkspace(
  home: string,
): Promise<LocalWorkspace> {
  const settings = await readSettings(home);
  if (!settings) throw new SetupRequiredError();
  if (settings.version === 2 && settings.localWorkspace)
    return settings.localWorkspace;
  const workspace = await localWorkspace(home);
  const kept = await localRepoSource(workspace, home).model();
  const next: Settings = {
    ...upgradeSettings(settings),
    localWorkspace: workspace,
  };
  await saveSettings(
    withSelection(next, withLocalSubscription(selectionState(next), kept)),
    home,
  );
  return workspace;
}

/**
 * Brings Skills linked from outside folders into the workspace, so every asset on
 * this machine lives in one place. The originals are left alone.
 */
export async function adoptLinkedFolders(home: string): Promise<string[]> {
  const settings = await readSettings(home);
  if (!settings) return [];
  const linked = upgradeSettings(settings).skills.filter(
    (skill) => skill.kind === "local",
  );
  if (!linked.length) return [];
  const notices: string[] = [];
  const adopted: { id: string; name: string; enabled: boolean }[] = [];
  for (const entry of linked) {
    const source = resolve(dirname(settingsPath(home)), entry.source);
    try {
      const remote = await readFolder(source);
      const { skills, skipped } = discoverSkills(remote);
      const skill = skills.find((s) => s.root === "");
      if (!skill)
        throw new CliError(skipped[0]?.reason ?? "It has no valid SKILL.md.");
      await saveImported(
        {
          kind: "skill",
          name: skill.name,
          entries: skill.entries,
          mode: "fork",
          remote,
          root: "",
        },
        home,
      );
      adopted.push({ id: entry.id, name: skill.name, enabled: entry.enabled });
      notices.push(
        `Copied ${skill.name} into your workspace. The original folder wasn't changed.`,
      );
    } catch (error) {
      notices.push(
        `Couldn't copy ${source} into your workspace, so it stays linked for now: ${friendlyMessage(error)}`,
      );
    }
  }
  if (!adopted.length) return notices;
  const current = upgradeSettings(
    defined(await readSettings(home), "Settings disappeared during adoption"),
  );
  const ids = new Set(adopted.map((skill) => skill.id));
  const skills = current.skills.filter((skill) => !ids.has(skill.id));
  const off = new Set(adopted.filter((s) => !s.enabled).map((s) => s.name));
  const selection = selectionState(current);
  const assets = off.size
    ? (
        await localRepoSource(
          defined(current.localWorkspace, "Adoption needs a local workspace"),
          home,
        ).model()
      ).assets
    : [];
  await saveSettings(
    off.size
      ? {
          ...current,
          skills,
          environment: {
            ...selection,
            disabledAssetIds: [
              ...selection.disabledAssetIds,
              ...assets
                .filter((a) => a.kind === "skill" && off.has(a.name))
                .map((a) => a.id),
            ],
          },
        }
      : { ...current, skills },
    home,
  );
  return notices;
}

function folderFor(kind: PackageKind, name: string) {
  assertAssetName(
    name,
    `barndog ${assetKinds[kind].command} add <source> --as <new-name>`,
  );
  return assetPath("org", kind, name);
}

async function assertFree(root: string, kind: PackageKind, name: string) {
  try {
    if (!(await readdir(root)).length) return;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return;
    if (code !== "ENOTDIR") throw error;
  }
  throw new CliError(
    `A local ${assetKinds[kind].one} named ${name} already exists at ${root}.`,
    `barndog ${assetKinds[kind].command} add <source> --as <new-name>`,
  );
}

export async function saveImported(
  input: {
    kind: "skill" | "hook";
    name: string;
    entries: PackageEntry[];
    mode: UpdateMode;
    remote: RemoteRepo;
    root: string;
    files?: string[];
  },
  home = homedir(),
) {
  const relative = folderFor(input.kind, input.name);
  const workspace = await ensureLocalWorkspace(home);
  const target = join(workspace.path, relative);
  await assertFree(target, input.kind, input.name);
  await mkdir(target, { recursive: true });
  await rm(target, { recursive: true, force: true });
  await writePackage(target, input.entries);
  if (input.mode !== "fork") {
    const sources = await readSources(workspace.path);
    sources.imports = sources.imports.filter(
      (entry) => !(entry.kind === input.kind && entry.name === input.name),
    );
    sources.imports.push({
      kind: input.kind,
      name: input.name,
      mode: input.mode,
      url: input.remote.url,
      ref: input.remote.ref,
      root: input.root,
      commit: input.remote.commit,
      ...(input.files ? { files: input.files } : {}),
      fingerprint: packageFingerprint(input.entries),
    });
    await writeSources(workspace.path, sources);
  }
  return { path: target };
}

export function renamedSkill(skill: SkillCandidate, name: string) {
  return skill.name === name
    ? skill.entries
    : renameSkillEntries(skill.entries, name);
}

function latestEntries(
  record: ImportRecord,
  remote: RemoteRepo,
  current: PackageEntry[],
) {
  const all = folderEntries(remote, record.root);
  if (!all.length)
    throw new CliError(
      `${record.root || "That folder"} no longer exists in ${record.url}.`,
    );
  const { files } = record;
  if (files) {
    const manifest = defined(
      current.find((entry) => entry.path === "hook.yaml"),
      `${record.name} has no hook.yaml`,
    );
    return [...all.filter((entry) => files.includes(entry.path)), manifest];
  }
  if (record.kind === "skill") {
    const manifestName = /^name:\s*(\S+)/m.exec(
      all.find((entry) => entry.path === "SKILL.md")?.data.toString("utf8") ??
        "",
    )?.[1];
    return manifestName && manifestName !== record.name
      ? renameSkillEntries(all, record.name)
      : all;
  }
  return all;
}

async function applyUpdate(
  folder: string,
  sources: Sources,
  record: ImportRecord,
  options: { force?: boolean; dryRun?: boolean; allowPrompt: boolean },
) {
  const target = join(folder, folderFor(record.kind, record.name));
  const current = await readDirectory(target);
  if (packageFingerprint(current) !== record.fingerprint && !options.force)
    throw new CliError(
      `${record.name} was edited locally, so updating would lose those edits.`,
      `barndog ${assetKinds[record.kind].command} update ${record.name} --force`,
    );
  return fetchRemote(
    { url: record.url, rest: null, ref: record.ref, path: record.root },
    { allowPrompt: options.allowPrompt },
    async (remote) => {
      const next = latestEntries(record, remote, current);
      const changes = await diffEntries(current, next);
      if (changes.length && !options.dryRun) {
        await rm(target, { recursive: true, force: true });
        await writePackage(target, next);
        record.commit = remote.commit;
        record.fingerprint = packageFingerprint(next);
        await writeSources(folder, sources);
      }
      return { name: record.name, commit: remote.commit, changes };
    },
  );
}

/** `barndog skills update`: brings imported assets up to their source on request. */
export async function updateImported(
  kind: "skill" | "hook",
  name: string | undefined,
  options: { force?: boolean; dryRun?: boolean },
  home = homedir(),
) {
  const settings = await readSettings(home);
  if (settings?.version !== 2 || !settings.localWorkspace)
    throw new CliError("This machine has no assets added from a repo.");
  const folder = settings.localWorkspace.path;
  const sources = await readSources(folder);
  const records = sources.imports.filter(
    (entry) =>
      entry.kind === kind &&
      // Older versions could record a name sync ignores; it mustn't stop the others.
      (name ? entry.name === name : validAssetName(entry.name)),
  );
  if (name && !records.length)
    throw new CliError(
      `${name} wasn't added from a repo, so it has nothing to update from.`,
    );
  const results = [];
  for (const record of records)
    results.push(
      await applyUpdate(folder, sources, record, {
        ...options,
        allowPrompt: true,
      }),
    );
  return results;
}

const FOLLOW_INTERVAL_MS = 5 * 60 * 1000;

/** Runs before sync. A repo that fails or was edited locally never blocks delivery. */
export async function followImports(
  folder: string,
  policy: "always" | "auto" | "none",
) {
  const sources = await readSources(folder);
  const followed = sources.imports.filter((entry) => entry.mode === "auto");
  const notices: string[] = [];
  if (!followed.length || policy === "none") return notices;
  if (
    policy === "auto" &&
    sources.checkedAt &&
    Date.now() - Date.parse(sources.checkedAt) < FOLLOW_INTERVAL_MS
  )
    return notices;
  for (const record of followed)
    await applyUpdate(folder, sources, record, { allowPrompt: false }).catch(
      (error: Error) => {
        notices.push(
          `${record.name} wasn't updated from its repo: ${error.message}`,
        );
      },
    );
  sources.checkedAt = new Date().toISOString();
  await writeSources(folder, sources);
  return notices;
}
