import { GIT_MODE } from "../git-workspace/snapshot.js";
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

import { CliError, friendlyMessage } from "../../errors.js";
import { harnesses, hookSettingsOwner } from "../../harnesses/registry.js";
import type { Harness } from "../../harnesses/types.js";
import { isBlob, type SnapshotEntry } from "../git-workspace/snapshot.js";
import type { RemoteRepo } from "./remote.js";
import { defined } from "../../shared/lookup.js";
import { asRecord, isRecord } from "../../shared/values.js";

/**
 * What imported Hook commands use for the installed package folder; BarnDog
 * binds it when installing.
 */
const ROOT_TOKEN = "${BARNDOG_HOOK_ROOT}";

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
      data: blobOf(remote, entry),
      executable: entry.mode === GIT_MODE.executable,
    }));
}

/** Every blob in a fetched snapshot was read with it. */
const blobOf = (remote: RemoteRepo, entry: SnapshotEntry) =>
  defined(remote.blobs.get(entry.hash), `Git object ${entry.hash} wasn't read`);

const hasLink = (remote: RemoteRepo, root: string) =>
  remote.snapshot.entries.some(
    (entry) =>
      entry.path.startsWith(root ? `${root}/` : "") &&
      (entry.mode === GIT_MODE.symlink || entry.mode === GIT_MODE.submodule),
  );

const parentOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

export type SkillCandidate = {
  name: string;
  description: string;
  root: string;
  entries: PackageEntry[];
};

type Skipped = { path: string; reason: string };

/**
 * Every valid Skill folder (one holding `SKILL.md`) in the linked part of a
 * fetched repository. Folders with symbolic links or invalid packages are
 * skipped with a reason.
 */
export function discoverSkills(remote: RemoteRepo) {
  const skills: SkillCandidate[] = [];
  const skipped: Skipped[] = [];
  for (const entry of remote.snapshot.entries) {
    if (fileName(entry.path) !== "SKILL.md" || !isBlob(entry.mode)) {
      continue;
    }

    const root = parentOf(entry.path);
    if (!inScope(remote, root) && !inScope(remote, entry.path)) {
      continue;
    }

    try {
      if (hasLink(remote, root)) {
        throw new CliError("It contains a symbolic link");
      }

      const entries = validatePackageEntries(folderEntries(remote, root));
      const metadata = packageMetadata(entries);
      skills.push({ ...metadata, root, entries });
    } catch (error) {
      skipped.push({ path: entry.path, reason: friendlyMessage(error) });
    }
  }

  return { skills, skipped };
}

/**
 * One hook command found in a harness's settings, rewritten to run its script
 * from the package folder.
 */
export type DraftEvent = {
  event: string;
  matcher?: string;
  /** Repo path of the script this runs. */
  script: string;
  /** Full command, with `@@<repo path>` standing in for the script. */
  command: string;
};

/**
 * A Hook found in a repository: a ready package with `hook.yaml`, or a draft
 * assembled from harness settings files.
 */
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

/** The last segment of a repository path: `hooks/lint/hook.yaml` → `hook.yaml`. */
const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** `.py` from `hooks/check.py`; "" when the file name has no extension. */
const extensionOf = (path: string) => {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");

  return dot > 0 ? name.slice(dot) : "";
};

/** What a script without its executable bit is run with, by extension. */
const interpreters: Record<string, string> = {
  ".py": "python3 ",
  ".js": "node ",
  ".mjs": "node ",
  ".cjs": "node ",
  ".rb": "ruby ",
  ".pl": "perl ",
};

const scriptExtensions = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".ts",
  ...Object.keys(interpreters),
]);

/**
 * Whether a repository file looks like a hook script: `hooks/check.sh`, `lint.mjs`.
 *
 * @internal Exported for its table test in `src/tests/patterns.test.ts`.
 */
export const scriptLike = (path: string) =>
  scriptExtensions.has(extensionOf(path));

/**
 * A command that runs `script` from the package: `@@check.sh` when it is
 * executable, else through its interpreter, `python3 @@check.py`.
 */
export function plainCommand(script: string, executable: boolean) {
  const interpreter = executable
    ? ""
    : (interpreters[extensionOf(script)] ?? "");

  return `${interpreter}@@${script}`;
}

type NativeHook = { event: string; matcher?: string; command: string };

function nativeHooks(entry: SnapshotEntry, text: string) {
  const parsed: unknown = entry.path.endsWith(".toml")
    ? parseToml(text)
    : parseJsonc(text);

  const found: NativeHook[] = [];
  for (const [event, groups] of Object.entries(
    asRecord(asRecord(parsed).hooks),
  )) {
    if (!Array.isArray(groups)) {
      continue;
    }

    for (const group of groups.filter(isRecord)) {
      const matcher =
        typeof group.matcher === "string" && group.matcher
          ? group.matcher
          : undefined;

      const handlers = Array.isArray(group.hooks)
        ? group.hooks.filter(isRecord)
        : [group];

      for (const handler of handlers) {
        if (
          typeof handler.command === "string" &&
          (handler.type ?? "command") === "command"
        ) {
          found.push({ event, matcher, command: handler.command });
        }
      }
    }
  }

  return found;
}

/**
 * Leading folders a native command uses to find its repository, which don't
 * exist in the package: `$CLAUDE_PROJECT_DIR/`, `${CLAUDE_PLUGIN_ROOT}/`,
 * `$(git rev-parse --show-toplevel)/`, `~/` and `./`, in any combination.
 */
const ROOT_PREFIXES =
  /^(?:\$\{?[A-Z_]+\}?\/|\$\(git rev-parse --show-toplevel\)\/|~\/|\.\/)+/;

/** Surrounding quotes on one word of a command: `"./run.sh"` → `./run.sh`. */
const QUOTES = /^["']|["']$/g;

/**
 * The repository-relative path one word of a native hook command may name:
 * `"$CLAUDE_PROJECT_DIR/.claude/hooks/check.sh"` → `.claude/hooks/check.sh`.
 *
 * @internal Exported for its table test in `src/tests/patterns.test.ts`.
 */
export function scriptPath(token: string) {
  return token.replace(QUOTES, "").replace(ROOT_PREFIXES, "");
}

/** Points a native command at the repo's script, or says why it can't be carried over. */
function rewriteCommand(command: string, blobs: string[], scope: string) {
  for (const token of command.split(/\s+/)) {
    const relative = scriptPath(token);
    if (!relative || !relative.includes(".")) {
      continue;
    }

    const script =
      blobs.find((path) => path === relative) ??
      blobs.find((path) => scope && path === `${scope}/${relative}`) ??
      blobs.find((path) => path.endsWith(`/${relative}`));

    if (script) {
      return { script, command: command.replace(token, () => `@@${script}`) };
    }
  }

  return null;
}

/**
 * The Hook packages in the linked part of a fetched repository. When there are
 * none, builds one draft from the harness settings files it finds (named
 * `fallbackName`), so a repository of plain hook scripts can still be imported.
 */
export function discoverHooks(remote: RemoteRepo, fallbackName: string) {
  const packages: HookCandidate[] = [];
  const skipped: Skipped[] = [];
  for (const entry of remote.snapshot.entries) {
    if (fileName(entry.path) !== "hook.yaml" || !isBlob(entry.mode)) {
      continue;
    }

    const root = parentOf(entry.path);
    if (!inScope(remote, root) && !inScope(remote, entry.path)) {
      continue;
    }

    try {
      if (hasLink(remote, root)) {
        throw new CliError("It contains a symbolic link");
      }

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

  if (packages.length) {
    return { candidates: packages, skipped };
  }

  const blobEntries = remote.snapshot.entries.filter(
    (e) => isBlob(e.mode) && inScope(remote, e.path),
  );

  const blobPaths = blobEntries.map((e) => e.path);
  const implementations: Partial<Record<Harness, DraftEvent[]>> = {};
  for (const entry of blobEntries) {
    const harness = hookSettingsOwner(entry.path);
    if (!harness) {
      continue;
    }

    let hooks: NativeHook[] = [];
    try {
      hooks = nativeHooks(entry, blobOf(remote, entry).toString("utf8"));
    } catch (error) {
      skipped.push({ path: entry.path, reason: friendlyMessage(error) });
    }

    for (const hook of hooks) {
      const rewritten = rewriteCommand(hook.command, blobPaths, remote.path);
      if (!rewritten) {
        skipped.push({
          path: entry.path,
          reason: `${hook.event}: "${hook.command}" doesn't run a script in this ${remote.path ? "folder" : "repo"}`,
        });
      } else {
        (implementations[harness] ??= []).push({
          event: hook.event,
          matcher: hook.matcher,
          ...rewritten,
        });
      }
    }
  }

  const scripts = [
    ...new Set([
      ...Object.values(implementations)
        .flat()
        .map((d) => d.script),
      ...blobEntries
        .filter((e) => scriptLike(e.path) || e.mode === GIT_MODE.executable)
        .map((e) => e.path),
    ]),
  ];

  if (!scripts.length) {
    return { candidates: [], skipped };
  }

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
  for (const other of parts) {
    while (
      length &&
      other.slice(0, length).join("/") !== first.slice(0, length).join("/")
    ) {
      length--;
    }
  }

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
  const scripts = [...new Set(used.map((d) => d.script))];
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
      data: blobOf(remote, entry),
      executable:
        entry.mode === GIT_MODE.executable || scripts.includes(entry.path),
    }));

  const implementations: HookManifest["implementations"] = {};
  for (const harness of harnesses) {
    const events = input.implementations[harness] ?? [];
    if (!events.length) {
      continue;
    }

    const byEvent: Record<string, unknown[]> = {};
    for (const draft of events) {
      const command = draft.command.replace(
        `@@${draft.script}`,
        () => `${ROOT_TOKEN}/${relative(draft.script)}`,
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
