import {
  hookImplementationSchema,
  type HookManifest,
} from "@barndog-ai/api-contract";
import {
  hookMetadata,
  packageMetadata,
  validatePackageEntries,
  type PackageEntry,
} from "@barndog-ai/api-contract/package";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { stringify } from "yaml";

import { friendlyMessage } from "../../errors.js";
import { adapters, harnesses } from "../../harnesses/registry.js";
import type { Harness } from "../../harnesses/types.js";
import { isBlob, type SnapshotEntry } from "../git-workspace/snapshot.js";
import type { RemoteRepo } from "./remote.js";

export const ROOT_TOKEN = "${BARNDOG_HOOK_ROOT}";

/** A link to a folder or file narrows everything to it; the rest of the repo is ignored. */
const inScope = (remote: RemoteRepo, path: string) =>
  !remote.path || path === remote.path || path.startsWith(`${remote.path}/`);

/** Whether the folder or file the link pointed at is in the repo at all. */
export const scopeExists = (remote: RemoteRepo) =>
  !remote.path || remote.snapshot.entries.some((e) => inScope(remote, e.path));

/** Files under a folder, as package entries relative to it. */
export function folderEntries(
  remote: RemoteRepo,
  root: string,
): PackageEntry[] {
  const prefix = root ? `${root}/` : "";
  return remote.snapshot.entries
    .filter((entry) => entry.path.startsWith(prefix) && isBlob(entry.mode))
    .map((entry) => ({
      path: entry.path.slice(prefix.length),
      data: remote.blobs.get(entry.hash)!,
      executable: entry.mode === "100755",
    }));
}

const hasLink = (remote: RemoteRepo, root: string) =>
  remote.snapshot.entries.some(
    (entry) =>
      entry.path.startsWith(root ? `${root}/` : "") &&
      (entry.mode === "120000" || entry.mode === "160000"),
  );

const parentOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

export type SkillCandidate = {
  name: string;
  description: string;
  root: string;
  entries: PackageEntry[];
};

export type Skipped = { path: string; reason: string };

export function discoverSkills(remote: RemoteRepo) {
  const skills: SkillCandidate[] = [];
  const skipped: Skipped[] = [];
  for (const entry of remote.snapshot.entries) {
    if (!/(^|\/)SKILL\.md$/.test(entry.path) || !isBlob(entry.mode)) continue;
    const root = parentOf(entry.path);
    if (!inScope(remote, root) && !inScope(remote, entry.path)) continue;
    try {
      if (hasLink(remote, root)) throw new Error("It contains a symbolic link");
      const entries = validatePackageEntries(folderEntries(remote, root));
      const metadata = packageMetadata(entries);
      skills.push({ ...metadata, root, entries });
    } catch (error) {
      skipped.push({ path: entry.path, reason: friendlyMessage(error) });
    }
  }
  return { skills, skipped };
}

export type DraftEvent = {
  event: string;
  matcher?: string;
  /** Repo path of the script this runs. */
  script: string;
  /** Full command, with `@@<repo path>` standing in for the script. */
  command: string;
};

export type HookCandidate =
  | {
      type: "package";
      name: string;
      description: string;
      root: string;
      entries: PackageEntry[];
    }
  | {
      type: "draft";
      name: string;
      scripts: string[];
      implementations: Partial<Record<Harness, DraftEvent[]>>;
      skipped: Skipped[];
    };

const scriptLike = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl)$/;

const interpreter = (script: string) =>
  /\.py$/.test(script)
    ? "python3 "
    : /\.(m|c)?js$/.test(script)
      ? "node "
      : /\.rb$/.test(script)
        ? "ruby "
        : /\.pl$/.test(script)
          ? "perl "
          : "";

export function plainCommand(script: string, executable: boolean) {
  return `${executable ? "" : interpreter(script)}@@${script}`;
}

type NativeHook = { event: string; matcher?: string; command: string };

function nativeHooks(entry: SnapshotEntry, text: string) {
  const parsed = entry.path.endsWith(".toml")
    ? (parseToml(text) as Record<string, unknown>)
    : (parseJsonc(text) as Record<string, unknown> | undefined);
  const hooks = parsed?.hooks as Record<string, unknown> | undefined;
  const found: NativeHook[] = [];
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups as Record<string, unknown>[]) {
      const matcher =
        typeof group.matcher === "string" && group.matcher
          ? group.matcher
          : undefined;
      const handlers = Array.isArray(group.hooks)
        ? (group.hooks as Record<string, unknown>[])
        : [group];
      for (const handler of handlers)
        if (
          typeof handler.command === "string" &&
          (handler.type ?? "command") === "command"
        )
          found.push({ event, matcher, command: handler.command });
    }
  }
  return found;
}

const settingsOwner = (path: string) =>
  harnesses.find((harness) =>
    adapters[harness].hooks.settings.some((pattern) => pattern.test(path)),
  );

const pathNoise =
  /^(\$\{?[A-Z_]+\}?\/|\$\(git rev-parse --show-toplevel\)\/|~\/|\.\/)+/;

/** Points a native command at the repo's script, or says why it can't be carried over. */
function rewriteCommand(command: string, blobs: string[], scope: string) {
  for (const token of command.split(/\s+/)) {
    const clean = token.replace(/^["']|["']$/g, "");
    const relative = clean.replace(pathNoise, "");
    if (!relative || !relative.includes(".")) continue;
    const script =
      blobs.find((path) => path === relative) ??
      blobs.find((path) => scope && path === `${scope}/${relative}`) ??
      blobs.find((path) => path.endsWith(`/${relative}`));
    if (script)
      return { script, command: command.replace(token, `@@${script}`) };
  }
  return null;
}

export function discoverHooks(remote: RemoteRepo, fallbackName: string) {
  const packages: HookCandidate[] = [];
  const skipped: Skipped[] = [];
  for (const entry of remote.snapshot.entries) {
    if (!/(^|\/)hook\.yaml$/.test(entry.path) || !isBlob(entry.mode)) continue;
    const root = parentOf(entry.path);
    if (!inScope(remote, root) && !inScope(remote, entry.path)) continue;
    try {
      if (hasLink(remote, root)) throw new Error("It contains a symbolic link");
      const entries = validatePackageEntries(
        folderEntries(remote, root),
        undefined,
        "hook.yaml",
      );
      const manifest = hookMetadata(entries);
      packages.push({
        type: "package",
        name: manifest.name,
        description: manifest.description,
        root,
        entries,
      });
    } catch (error) {
      skipped.push({ path: entry.path, reason: friendlyMessage(error) });
    }
  }
  if (packages.length) return { candidates: packages, skipped };
  const blobEntries = remote.snapshot.entries.filter(
    (e) => isBlob(e.mode) && inScope(remote, e.path),
  );
  const blobPaths = blobEntries.map((e) => e.path);
  const implementations: Partial<Record<Harness, DraftEvent[]>> = {};
  for (const entry of blobEntries) {
    const harness = settingsOwner(entry.path);
    if (!harness) continue;
    let hooks: NativeHook[] = [];
    try {
      hooks = nativeHooks(
        entry,
        remote.blobs.get(entry.hash)!.toString("utf8"),
      );
    } catch (error) {
      skipped.push({ path: entry.path, reason: friendlyMessage(error) });
    }
    for (const hook of hooks) {
      const rewritten = rewriteCommand(hook.command, blobPaths, remote.path);
      if (!rewritten)
        skipped.push({
          path: entry.path,
          reason: `${hook.event}: "${hook.command}" doesn't run a script in this ${remote.path ? "folder" : "repo"}`,
        });
      else
        (implementations[harness] ??= []).push({
          event: hook.event,
          matcher: hook.matcher,
          ...rewritten,
        });
    }
  }
  const scripts = [
    ...new Set([
      ...Object.values(implementations)
        .flat()
        .map((d) => d!.script),
      ...blobEntries
        .filter((e) => scriptLike.test(e.path) || e.mode === "100755")
        .map((e) => e.path),
    ]),
  ];
  if (!scripts.length) return { candidates: [], skipped };
  return {
    candidates: [
      {
        type: "draft" as const,
        name: fallbackName,
        scripts,
        implementations,
        skipped,
      },
    ],
    skipped,
  };
}

const commonFolder = (paths: string[]) => {
  const parts = paths.map((path) => path.split("/").slice(0, -1));
  const first = parts[0] ?? [];
  let length = first.length;
  for (const other of parts)
    while (
      length &&
      other.slice(0, length).join("/") !== first.slice(0, length).join("/")
    )
      length--;
  return first.slice(0, length).join("/");
};

/** Turns the choices made in the picker into a Hook package in BarnDog's format. */
export function buildHookPackage(
  remote: RemoteRepo,
  input: {
    name: string;
    description: string;
    implementations: Partial<Record<Harness, DraftEvent[]>>;
  },
) {
  const used = Object.values(input.implementations).flat();
  const scripts = [...new Set(used.map((d) => d!.script))];
  const root = commonFolder(scripts);
  const relative = (path: string) =>
    root ? path.slice(root.length + 1) : path;
  // Helpers usually sit beside a script; a script at the repo root travels alone.
  const folders = [...new Set(scripts.map(parentOf))];
  const files = remote.snapshot.entries
    .filter(
      (entry) =>
        isBlob(entry.mode) &&
        (scripts.includes(entry.path) ||
          folders.some(
            (folder) => folder && entry.path.startsWith(`${folder}/`),
          )),
    )
    .map((entry) => ({
      path: relative(entry.path),
      data: remote.blobs.get(entry.hash)!,
      executable: entry.mode === "100755" || scripts.includes(entry.path),
    }));
  const implementations: HookManifest["implementations"] = {};
  for (const [harness, events] of Object.entries(input.implementations) as [
    Harness,
    DraftEvent[],
  ][]) {
    if (!events.length) continue;
    const byEvent: Record<string, unknown[]> = {};
    for (const draft of events) {
      const command = draft.command.replace(
        new RegExp(`@@${draft.script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
        `${ROOT_TOKEN}/${relative(draft.script)}`,
      );
      (byEvent[draft.event] ??= []).push(
        harness === "cursor"
          ? { command, ...(draft.matcher ? { matcher: draft.matcher } : {}) }
          : {
              ...(draft.matcher ? { matcher: draft.matcher } : {}),
              hooks: [{ type: "command", command }],
            },
      );
    }
    implementations[harness] = {
      compatibility: "supported",
      scripts: [...new Set(events.map((e) => relative(e.script)))],
      requirements: { commands: [] },
      events: hookImplementationSchema.shape.events.parse(byEvent),
    };
  }
  const manifest = {
    name: input.name,
    description: input.description,
    implementations,
  };
  const entries: PackageEntry[] = [
    ...files.filter((file) => file.path !== "hook.yaml"),
    {
      path: "hook.yaml",
      data: Buffer.from(stringify(manifest)),
      executable: false,
    },
  ];
  hookMetadata(validatePackageEntries(entries, undefined, "hook.yaml"));
  return { root, entries, files: files.map((file) => file.path) };
}
