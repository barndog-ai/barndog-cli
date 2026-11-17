import { assertPackagePaths, removeCommand } from "../../platform.js";
import { writePackage, readDirectory } from "../workspace/directory.js";
import type { RuntimeContext } from "../../runtime.js";
import { CliError, PackageError } from "../../errors.js";
import { randomUUID, createHash } from "node:crypto";

import { join, dirname, isAbsolute } from "node:path";
import { readdir, realpath, rm, lstat } from "node:fs/promises";
import { z } from "zod";

import { changeUploadSchema } from "@barndog-ai/api-contract";
import {
  packageFingerprint,
  type PackageEntry,
} from "@barndog-ai/api-contract/package";

import { packageKindList } from "../../config/selection.js";
import { GIT_OBJECT_ID } from "../../shared/patterns.js";
import { readIfExists, writeAtomic } from "../../shared/files.js";
import { withPidLock } from "../../shared/lock.js";
import { barndogPaths } from "../../config/paths.js";

const filesSchema = z.array(
  z.object({ path: z.string(), content: z.string(), executable: z.boolean() }),
);

/**
 * Package files as JSON can hold them: base64 content plus the executable bit.
 */
export type Files = z.infer<typeof filesSchema>;

/**
 * What a push sends besides the files. `assetId` is the Skill or Hook being
 * revised, absent until the package is first published; the kind's route names
 * it `skillId` or `hookId` (`collaboration/api.ts`).
 */
const uploadSchema = changeUploadSchema
  .omit({ skillId: true })
  .extend({ assetId: z.uuid().optional() });

export type PackageUpload = z.infer<typeof uploadSchema>;

const workspaceSchema = z.object({
  kind: z.enum(packageKindList),
  root: z.string().refine(isAbsolute),
  connection: z.object({
    server: z.string(),
    organizationId: z.uuid(),
    developerId: z.uuid(),
  }),
  assetId: z.uuid().optional(),
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
      metadata: uploadSchema,
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
 * The files in a working copy. On Windows their executable flags come from
 * its base, as they were when BarnDog wrote them (see `readDirectory()`).
 */
export const readWorkingCopy = (
  work: { root: string; base: Files },
  runtime: RuntimeContext,
) => readDirectory(work.root, runtime, decodeFiles(work.base));

/** A working copy's record, keyed by a hash of its folder's path. */
/**
 * The files a working copy held before an interrupted update. Without them
 * BarnDog can't tell its own writes from the person's edits, so it touches
 * nothing and says how to start over.
 */
async function recoverySnapshot(work: StoredRecord, runtime: RuntimeContext) {
  const damaged = (reason: string, cause?: unknown) =>
    new CliError(
      `An update of ${work.root} was interrupted, and ${reason}, so BarnDog left the folder as it is.`,
      "Save any edits in the folder elsewhere, then remove its working-copy record and pull it again",
      {
        cause,
        command: removeCommand(
          recordPath(work.root, runtime),
          runtime.platform,
        ),
      },
    );

  const path = work.pendingSnapshot;
  if (
    !path?.startsWith(barndogPaths(runtime.home).workingCopySnapshots + "/")
  ) {
    throw damaged("its record doesn't point at a recovery snapshot");
  }

  const text = await readIfExists(path);
  if (text === null) {
    throw damaged(`its recovery snapshot ${path} is gone`);
  }

  try {
    return z.object({ files: filesSchema }).parse(JSON.parse(text));
  } catch (error) {
    throw damaged(`its recovery snapshot ${path} is damaged`, error);
  }
}

function recordPath(root: string, runtime: RuntimeContext) {
  const { home } = runtime;

  return join(
    barndogPaths(home).workingCopies,
    createHash("sha256").update(root).digest("hex") + ".json",
  );
}

/** Writes a working-copy record atomically, replacing the previous one. */
export async function save<T extends StoredRecord>(
  work: T,
  runtime: RuntimeContext,
) {
  await writeAtomic(recordPath(work.root, runtime), JSON.stringify(work));
}

/** Serializes working-copy changes across processes. */
export function locked<T>(
  runtime: RuntimeContext,
  run: () => Promise<T>,
): Promise<T> {
  const { home } = runtime;

  return withPidLock(
    barndogPaths(home).workingCopiesLock,
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
export const find = (runtime: RuntimeContext): Promise<Workspace> => {
  return findRecord(runtime, (value) => {
    if (value && typeof value === "object" && "git" in value) {
      throw new CliError(
        "This working copy belongs to a Git repo workspace, but this machine no longer uses one.",
        "barndog init",
      );
    }

    return workspaceSchema.parse(value);
  });
};

/** The Git working copy containing `cwd`; `find()` for Git workspaces. */
export const findGit = (runtime: RuntimeContext): Promise<GitWorkingCopy> => {
  return findRecord(runtime, (value) => {
    if (!value || typeof value !== "object" || !("git" in value)) {
      throw new CliError(
        "This working copy belongs to a BarnDog Cloud Workspace, but this machine now uses a Git repo.",
        "barndog init --server <url>",
      );
    }

    return gitWorkspaceSchema.parse(value);
  });
};

async function findRecord<T extends StoredRecord>(
  runtime: RuntimeContext,
  parse: (value: unknown) => T,
): Promise<T> {
  let path = await realpath(runtime.cwd);
  while (true) {
    const text = await readIfExists(recordPath(path, runtime));
    if (text !== null) {
      const work = parse(JSON.parse(text));

      if (work.root !== path) {
        throw new Error(
          `The working-copy record for ${path} names a different folder`,
        );
      }

      if (work.pendingWrite) {
        const snapshot = await recoverySnapshot(work, runtime);

        const allowed = [
          ...decodeFiles(snapshot.files),
          ...decodeFiles(work.pendingWrite),
        ];

        for (const file of await readDirectory(work.root, runtime, allowed)) {
          if (
            !allowed.some(
              (old) =>
                old.path === file.path &&
                old.data.equals(file.data) &&
                old.executable === file.executable,
            )
          ) {
            throw new CliError(
              `An interrupted update left edits it didn't make in ${file.path}. Save them elsewhere, then retry. The recovery snapshot is ${work.pendingSnapshot}.`,
            );
          }
        }

        await replaceFiles(work.root, decodeFiles(work.pendingWrite), runtime);
        delete work.pendingWrite;
        delete work.pendingSnapshot;
        await save(work, runtime);
      }

      return work;
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

async function replaceFiles(
  root: string,
  entries: PackageEntry[],
  runtime: RuntimeContext,
) {
  assertPackagePaths(entries, runtime.platform);
  // Validate paths and directory topology before touching local files.
  const paths = new Set(entries.map((e) => e.path));
  for (const path of paths) {
    if (
      path.startsWith("/") ||
      path.includes(":") ||
      path
        .split("/")
        .some(
          (p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git",
        ) ||
      path.includes("\\")
    ) {
      throw new PackageError("UNSAFE_PACKAGE_ENTRY", path);
    }

    for (const parent of path
      .split("/")
      .slice(0, -1)
      .map((_, i, a) => a.slice(0, i + 1).join("/"))) {
      if (paths.has(parent)) {
        throw new CliError(
          `A file and a folder share the path ${parent}. Keep one, then retry.`,
        );
      }
    }
  }

  const old = await readDirectory(root, runtime);
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
  await writePackage(root, entries, runtime);
}

/**
 * Replaces working files and saves the record. Saves the prior files and record
 * in a recovery snapshot first; the next working-copy lookup finishes an
 * interrupted write unless it detects additional local edits.
 */
export async function applyFiles<T extends StoredRecord>(
  work: T,
  entries: PackageEntry[],
  runtime: RuntimeContext,
  previous: T = work,
) {
  const { home } = runtime;

  const local = await readDirectory(work.root, runtime, entries);
  if (packageFingerprint(local) === packageFingerprint(entries)) {
    await save(work, runtime);

    return;
  }

  const snapshot = join(
    barndogPaths(home).workingCopySnapshots,
    `${Date.now()}-${randomUUID()}.json`,
  );

  await writeAtomic(
    snapshot,
    JSON.stringify({
      root: work.root,
      files: encodeFiles(local),
      workspace: previous,
    }),
  );

  work.pendingWrite = encodeFiles(entries);
  work.pendingSnapshot = snapshot;
  await save(work, runtime);
  await replaceFiles(work.root, entries, runtime);
  delete work.pendingWrite;
  delete work.pendingSnapshot;
  await save(work, runtime);
}
