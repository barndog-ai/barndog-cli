import { CliError } from "../../errors.js";
import { errorCode } from "../../shared/values.js";
import { randomUUID, createHash } from "node:crypto";

import { join, dirname, isAbsolute } from "node:path";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  realpath,
  rm,
  lstat,
} from "node:fs/promises";
import { z } from "zod";

import { changeUploadSchema } from "@barndog-ai/api-contract";
import {
  packageFingerprint,
  writePackage,
  type PackageEntry,
} from "@barndog-ai/api-contract/package";
import { readDirectory } from "@barndog-ai/api-contract/collaboration";
import { packageKindList } from "../asset-kinds/index.js";
import { GIT_OBJECT_ID } from "../../shared/patterns.js";
import { writeAtomic } from "../../shared/files.js";
import { withPidLock } from "../../shared/lock.js";

const filesSchema = z.array(
  z.object({ path: z.string(), content: z.string(), executable: z.boolean() }),
);

/**
 * Package files as JSON can hold them: base64 content plus the executable bit.
 */
export type Files = z.infer<typeof filesSchema>;

const workspaceSchema = z.object({
  kind: z.enum(packageKindList).default("skill"),
  root: z.string().refine(isAbsolute),
  connection: z.object({
    server: z.string(),
    organizationId: z.uuid(),
    developerId: z.uuid(),
  }),
  skillId: z.uuid().optional(),
  name: z.string(),
  origin: z.object({
    type: z.enum(["org", "team", "repo", "dev"]),
    id: z.uuid(),
  }),
  baseVersionId: z.uuid().nullable(),
  baseNumber: z.number().int().positive().nullable(),
  base: filesSchema,
  proposal: z
    .object({
      id: z.uuid(),
      revision: z.number().int().positive(),
      files: filesSchema,
    })
    .optional(),
  conflicts: z.array(z.string()),
  pending: z
    .object({
      metadata: changeUploadSchema,
      files: filesSchema,
      changeId: z.uuid().optional(),
    })
    .optional(),
  external: z
    .object({
      id: z.uuid(),
      pull: z
        .object({
          number: z.number().int().positive(),
          head: z.string(),
          files: filesSchema,
        })
        .optional(),
      pending: z
        .object({
          number: z.number().int().positive().optional(),
          expectedCommit: z.string(),
          files: filesSchema,
          title: z.string(),
          idempotencyKey: z.string(),
        })
        .optional(),
    })
    .optional(),
  pendingWrite: filesSchema.optional(),
  pendingSnapshot: z.string().optional(),
});

/**
 * A Cloud working copy's record in `~/.barndog/workspaces/`: its server
 * identity, the version and files it started from, its proposal, pending
 * uploads (kept with their retry keys) and unresolved conflicts.
 */
export type Workspace = z.infer<typeof workspaceSchema>;

const gitWorkspaceSchema = z.object({
  kind: z.enum(packageKindList),
  root: z.string().refine(isAbsolute),
  git: z.object({
    url: z.string(),
    branch: z.string(),
    workspaceId: z.uuid(),
  }),
  name: z.string(),
  scope: z.object({
    type: z.enum(["org", "team", "repo"]),
    slug: z.string(),
    path: z.string(),
  }),
  baseCommit: z.string().regex(GIT_OBJECT_ID),
  base: filesSchema,
  conflicts: z.array(z.string()),
  /** The branch under review; it stays until its content reaches the default branch. */
  review: z
    .object({
      branch: z.string(),
      head: z.string().regex(GIT_OBJECT_ID),
      files: filesSchema,
      url: z.string().optional(),
    })
    .optional(),
  pendingWrite: filesSchema.optional(),
  pendingSnapshot: z.string().optional(),
});

/**
 * A Git working copy's record in `~/.barndog/workspaces/`: the workspace and
 * scope, the commit and files it started from, and its review branch.
 */
export type GitWorkingCopy = z.infer<typeof gitWorkspaceSchema>;

/** The fields any working-copy record needs for saving and interrupted-write recovery. */
type StoredRecord = {
  root: string;
  pendingWrite?: Files;
  pendingSnapshot?: string;
};

/** Package entries as base64 `Files`, to store or send as JSON. */
export const encodeFiles = (entries: PackageEntry[]): Files =>
  entries.map((e) => ({
    path: e.path,
    content: e.data.toString("base64"),
    executable: e.executable,
  }));

export const decodeFiles = (files: Files): PackageEntry[] =>
  files.map((e) => ({
    path: e.path,
    data: Buffer.from(e.content, "base64"),
    executable: e.executable,
  }));

/**
 * `~/.barndog/workspaces/`: working-copy records, keyed by a hash of the folder
 * path, with their lock and recovery snapshots.
 */
export function directory(home: string) {
  return join(home, ".barndog", "workspaces");
}

function recordPath(root: string, home: string) {
  return join(
    directory(home),
    createHash("sha256").update(root).digest("hex") + ".json",
  );
}

/** Writes a working-copy record atomically, replacing the previous one. */
export async function save<T extends StoredRecord>(work: T, home: string) {
  await writeAtomic(recordPath(work.root, home), JSON.stringify(work));
}

/** Serializes working-copy changes across processes. */
export function locked<T>(home: string, run: () => Promise<T>): Promise<T> {
  return withPidLock(
    join(directory(home), "lock"),
    {
      starting:
        "Another BarnDog workspace operation is starting; retry shortly",
      running: "Another BarnDog workspace operation is running",
    },
    run,
  );
}

/** Root working-copy commands only make sense inside a pulled or created folder. */
export class NoWorkingCopyError extends CliError {}

/**
 * The Cloud working copy containing `cwd`, searching up from it. Finishes an
 * interrupted write first; throws `NoWorkingCopyError` when no folder above
 * `cwd` is registered, and a fix when the record belongs to a Git workspace.
 */
export const find = (cwd: string, home: string): Promise<Workspace> =>
  findRecord(cwd, home, (value) => {
    if (value && typeof value === "object" && "git" in value) {
      throw new CliError(
        "This working copy belongs to a Git repo workspace, but this machine no longer uses one.",
        "barndog init",
      );
    }

    return workspaceSchema.parse(value);
  });

/** The Git working copy containing `cwd`; `find()` for Git workspaces. */
export const findGit = (cwd: string, home: string): Promise<GitWorkingCopy> =>
  findRecord(cwd, home, (value) => {
    if (!value || typeof value !== "object" || !("git" in value)) {
      throw new CliError(
        "This working copy belongs to a BarnDog Cloud Workspace, but this machine now uses a Git repo.",
        "barndog init --server <url>",
      );
    }

    return gitWorkspaceSchema.parse(value);
  });

async function findRecord<T extends StoredRecord>(
  cwd: string,
  home: string,
  parse: (value: unknown) => T,
): Promise<T> {
  let path = await realpath(cwd);
  while (true) {
    try {
      const work = parse(
        JSON.parse(await readFile(recordPath(path, home), "utf8")),
      );

      if (work.root !== path) {
        throw new Error("Invalid workspace identity");
      }

      if (work.pendingWrite) {
        if (
          !work.pendingSnapshot?.startsWith(
            join(directory(home), "snapshots") + "/",
          )
        ) {
          throw new Error(
            "Interrupted workspace update has no recovery snapshot",
          );
        }

        const snapshot = z
          .object({ files: filesSchema })
          .parse(JSON.parse(await readFile(work.pendingSnapshot, "utf8")));

        const allowed = [
          ...decodeFiles(snapshot.files),
          ...decodeFiles(work.pendingWrite),
        ];

        for (const file of await readDirectory(work.root)) {
          if (
            !allowed.some(
              (old) =>
                old.path === file.path &&
                old.data.equals(file.data) &&
                old.executable === file.executable,
            )
          ) {
            throw new Error(
              `Interrupted update contains additional local edits: ${file.path}. Preserve them before retrying; recovery snapshot: ${work.pendingSnapshot}`,
            );
          }
        }

        await replaceFiles(work.root, decodeFiles(work.pendingWrite));
        delete work.pendingWrite;
        delete work.pendingSnapshot;
        await save(work, home);
      }

      return work;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    }

    if (dirname(path) === path) {
      break;
    }

    path = dirname(path);
  }

  throw new NoWorkingCopyError(
    "This folder isn't an editable Skill or Hook. Working-copy commands run inside a folder made by barndog skills pull, barndog hooks pull or barndog skills create.",
    "barndog skills pull <name>",
  );
}

async function replaceFiles(root: string, entries: PackageEntry[]) {
  // Validate paths and directory topology before touching local files.
  const paths = new Set(entries.map((e) => e.path));
  for (const path of paths) {
    if (
      path.startsWith("/") ||
      path
        .split("/")
        .some(
          (p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git",
        ) ||
      path.includes("\\")
    ) {
      throw new Error("UNSAFE_PACKAGE_ENTRY");
    }

    for (const parent of path
      .split("/")
      .slice(0, -1)
      .map((_, i, a) => a.slice(0, i + 1).join("/"))) {
      if (paths.has(parent)) {
        throw new Error(
          "Resolve the file/directory collision before updating this working copy",
        );
      }
    }
  }

  const old = await readDirectory(root);
  for (const entry of old) {
    await rm(join(root, entry.path));
  }

  // Remove empty directories bottom-up while preserving local .git directories.
  async function empty(path: string) {
    for (const name of await readdir(path)) {
      if (name.toLowerCase() !== ".git") {
        const child = join(path, name);
        if ((await lstat(child)).isDirectory()) {
          await empty(child);
          if (!(await readdir(child)).length) {
            await rm(child, { recursive: true });
          }
        }
      }
    }
  }

  await empty(root);
  await writePackage(root, entries);
}

/**
 * Replaces working files and saves the record. Saves the prior files and record
 * in a recovery snapshot first; the next working-copy lookup finishes an
 * interrupted write unless it detects additional local edits.
 */
export async function applyFiles<T extends StoredRecord>(
  work: T,
  entries: PackageEntry[],
  home: string,
  previous: T = work,
) {
  const local = await readDirectory(work.root);
  if (packageFingerprint(local) === packageFingerprint(entries)) {
    await save(work, home);

    return;
  }

  const snapshot = join(
    directory(home),
    "snapshots",
    `${Date.now()}-${randomUUID()}.json`,
  );

  await mkdir(dirname(snapshot), { recursive: true, mode: 0o700 });
  await writeFile(
    snapshot,
    JSON.stringify({
      root: work.root,
      files: encodeFiles(local),
      workspace: previous,
    }),
    { mode: 0o600 },
  );

  work.pendingWrite = encodeFiles(entries);
  work.pendingSnapshot = snapshot;
  await save(work, home);
  await replaceFiles(work.root, entries);
  delete work.pendingWrite;
  delete work.pendingSnapshot;
  await save(work, home);
}
