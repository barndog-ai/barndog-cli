import { directoryLinkType } from "../../platform.js";
import type { RuntimeContext } from "../../runtime.js";
import { POSIX_MODE } from "../../shared/constants.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { lstat, mkdir, readlink, rm, symlink, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { packageFingerprint } from "@barndog-ai/api-contract/package";
import {
  skillDirectory,
  harnesses,
  nativeFile,
} from "../../harnesses/registry.js";
import { z } from "zod";
import { connectionContext } from "../auth/session.js";
import type { JournalIdentity } from "../workspace/source.js";
import { NAME } from "../../shared/patterns.js";
import { desiredEntries, mirrorTree } from "../workspace/installed.js";
import { treeFingerprint } from "../workspace/tree.js";
import { fileText, ifExists, writeAtomic } from "../../shared/files.js";
import { withPidLock } from "../../shared/lock.js";
import { CliError } from "../../errors.js";
import { barndogPaths } from "../../config/paths.js";

/**
 * One journaled sync change. File values are text, link values are targets and
 * tree values are fingerprints; null means absent. Recovery checks file and
 * link values, but can overwrite a partially applied tree.
 */
export type Write =
  | {
      kind: "file" | "link";
      path: string;
      before: string | null;
      after: string | null;
    }
  | {
      /** An installed folder; before/after are content fingerprints. */
      kind: "tree";
      path: string;
      before: string | null;
      after: string | null;
      source: string | null;
      rename: string | null;
    };

const writeSchema = z.union([
  z
    .object({
      kind: z.enum(["file", "link"]),
      path: z.string(),
      before: z.string().nullable(),
      after: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tree"),
      path: z.string(),
      before: z.string().nullable(),
      after: z.string().nullable(),
      source: z.string().nullable(),
      rename: z.string().nullable(),
    })
    .strict(),
]);

const journalSchema = z
  .object({
    version: z.literal(1),
    writes: z.array(writeSchema),
    connection: z
      .object({
        server: z.string(),
        organizationId: z.uuid(),
        developerId: z.uuid(),
      })
      .optional(),
    workspaceId: z.uuid().optional(),
  })
  .strict();

const locks = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Where the Skill link at `path` points, or null when nothing is there. Throws
 * when something other than a symbolic link sits at `path`: BarnDog never takes
 * over a folder it didn't create.
 */
export async function linkTarget(path: string): Promise<string | null> {
  const info = await ifExists(lstat(path));
  if (!info) {
    return null;
  }

  if (!info.isSymbolicLink()) {
    throw new CliError(
      `${path} is a Skill folder BarnDog didn't install, so it won't replace it. Move or rename it, then sync again.`,
      "barndog sync",
    );
  }

  return resolve(dirname(path), await readlink(path));
}

function validateWrites(writes: Write[], runtime: RuntimeContext) {
  const { home } = runtime;

  const files = new Set([
    barndogPaths(home).settings,
    barndogPaths(home).state,
    ...harnesses.flatMap((h) => [
      nativeFile(h, "mcp", home),
      nativeFile(h, "hook", home),
    ]),
  ]);

  const paths = new Set<string>();
  for (const write of writes) {
    if (paths.has(write.path) || resolve(write.path) !== write.path) {
      throw new Error("A sync planned an invalid or duplicate destination");
    }

    paths.add(write.path);
    if (write.kind === "tree") {
      if (
        ![
          barndogPaths(home).installed("skill"),
          barndogPaths(home).installed("hook"),
        ].includes(dirname(write.path)) ||
        !NAME.test(basename(write.path)) ||
        (write.source !== null && !isAbsolute(write.source)) ||
        (write.after !== null) !== (write.source !== null) ||
        (write.rename !== null && !NAME.test(write.rename))
      ) {
        throw new Error("A sync planned an invalid destination");
      }

      continue;
    }

    if (
      write.kind === "file"
        ? !files.has(write.path)
        : !harnesses.some(
            (h) => dirname(write.path) === skillDirectory(h, home),
          ) ||
          [write.before, write.after].some((v) => v !== null && !isAbsolute(v))
    ) {
      throw new Error("A sync planned an invalid destination");
    }
  }
}

async function current(write: Write, runtime: RuntimeContext) {
  if (write.kind === "file") {
    return fileText(write.path);
  }

  if (write.kind === "link") {
    return linkTarget(write.path);
  }

  return treeFingerprint(write.path, runtime);
}

async function applyTree(
  write: Extract<Write, { kind: "tree" }>,
  runtime: RuntimeContext,
) {
  if (write.source === null) {
    await rm(write.path, { recursive: true, force: true });

    return;
  }

  // A folder kept in place has no other copy to restore; the next sync reinstalls it.
  if (write.source === write.path) {
    return;
  }

  const entries = await desiredEntries(write.source, write.rename, runtime);
  if (packageFingerprint(entries) !== write.after) {
    throw new CliError(
      `The downloaded copy in ${write.source} changed before it was installed.`,
      "barndog sync",
    );
  }

  await mirrorTree(write.path, entries, runtime);
}

async function apply(
  writes: Write[],
  runtime: RuntimeContext,
  checkpoint?: (index: number) => Promise<void>,
  recovering = false,
) {
  validateWrites(writes, runtime);
  // Check the entire recovery plan before writing any remaining destination.
  for (const write of writes) {
    // An interrupted in-place copy leaves a BarnDog-owned folder half written.
    if (write.kind === "tree" && recovering) {
      continue;
    }

    const value = await current(write, runtime);
    if (
      value !== write.before &&
      value !== write.after &&
      !(
        write.kind === "link" &&
        value === null &&
        write.before !== null &&
        write.after !== null
      )
    ) {
      throw new CliError(
        `${write.path} changed after a sync was interrupted. Save your edits elsewhere, then sync again.`,
        "barndog sync",
      );
    }
  }

  for (const [index, write] of writes.entries()) {
    const value = await current(write, runtime);
    if (value === write.after) {
      continue;
    }

    if (write.kind === "tree") {
      if (value !== write.before && !recovering) {
        throw new CliError(
          `${write.path} changed while syncing.`,
          "barndog sync",
        );
      }

      await applyTree(write, runtime);
      await checkpoint?.(index);
      continue;
    }

    if (
      value !== write.before &&
      !(
        write.kind === "link" &&
        value === null &&
        write.before !== null &&
        write.after !== null
      )
    ) {
      throw new CliError(
        `${write.path} changed while syncing.`,
        "barndog sync",
      );
    }

    await mkdir(dirname(write.path), {
      recursive: true,
      mode: POSIX_MODE.privateDirectory,
    });

    if (write.kind === "file") {
      if (write.after === null) {
        await unlink(write.path);
      } else {
        await writeAtomic(write.path, write.after);
      }
    } else {
      if (value !== null) {
        await unlink(write.path);
      }

      if (write.after !== null) {
        await symlink(
          write.after,
          write.path,
          directoryLinkType(runtime.platform),
        );
      }
    }

    await checkpoint?.(index);
  }
}

/**
 * The journal an interrupted sync left. One that doesn't parse or names a
 * destination BarnDog never writes was changed by hand or damaged, so it is
 * kept and nothing is applied.
 */
function readJournal(text: string, runtime: RuntimeContext) {
  try {
    const journal = journalSchema.parse(JSON.parse(text));
    validateWrites(journal.writes, runtime);

    return journal;
  } catch (error) {
    throw new CliError(
      `${barndogPaths(runtime.home).pendingSync} is damaged, so BarnDog can't safely finish the interrupted sync.`,
      "Move that file aside (keep it), check the files it lists, then run barndog sync",
      { cause: error },
    );
  }
}

/**
 * Rolls forward an interrupted sync from ~/.barndog/pending-sync.json.
 * Rejects a cloud journal when its authenticated organization or developer
 * has changed.
 */
async function recover(runtime: RuntimeContext) {
  const { home } = runtime;

  const path = barndogPaths(home).pendingSync;
  const text = await fileText(path);

  if (text === null) {
    return;
  }

  const journal = readJournal(text, runtime);
  if (journal.connection) {
    const actual = await connectionContext(journal.connection.server, runtime);
    if (
      actual.organizationId !== journal.connection.organizationId ||
      actual.developerId !== journal.connection.developerId
    ) {
      throw new CliError(
        "An interrupted sync belongs to another organization or developer. Sign in as them to finish it.",
        "barndog login",
      );
    }
  }

  await apply(journal.writes, runtime, undefined, true);
  await unlink(path);
}

/**
 * Applies `writes` as one journaled operation: records them in
 * `~/.barndog/pending-sync.json`, applies them in order and removes the
 * journal, so `recover()` can finish the job after a crash. Backs up the
 * previous `config.yaml` under `~/.barndog/migrations/` before changing it.
 * `checkpoint` runs after each write is applied. Call it inside `locked()`.
 */
export async function transact(
  runtime: RuntimeContext,
  writes: Write[],
  identity?: JournalIdentity,
  checkpoint?: (index: number) => Promise<void>,
) {
  const { home } = runtime;

  writes = writes.filter((w) => w.before !== w.after);
  if (!writes.length) {
    return;
  }

  validateWrites(writes, runtime);
  const config = writes.find((w) => w.path === barndogPaths(home).settings);
  if (config?.before) {
    const backup = join(
      barndogPaths(home).migrations,
      `config-${createHash("sha256").update(config.before).digest("hex")}.yaml`,
    );

    const previous = await fileText(backup);
    if (previous === null) {
      await writeAtomic(backup, config.before);
    } else if (previous !== config.before) {
      throw new CliError(
        `${backup} was changed after BarnDog saved it, so ${barndogPaths(home).settings} was left as it is.`,
        "Move that backup aside (keep it), then run the command again",
      );
    }
  }

  const path = barndogPaths(home).pendingSync;
  await writeAtomic(
    path,
    JSON.stringify(
      identity && "workspaceId" in identity
        ? { version: 1, writes, workspaceId: identity.workspaceId }
        : { version: 1, writes, connection: identity },
    ),
  );

  await apply(writes, runtime, checkpoint);
  await unlink(path);
}

const INTERRUPTS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

const interruptions = new Set<() => void>();

function interrupted(signal: NodeJS.Signals) {
  for (const cleanup of interruptions) {
    cleanup();
  }

  interruptions.clear();
  for (const name of INTERRUPTS) {
    process.removeListener(name, interrupted);
  }

  process.kill(process.pid, signal);
}

/** Runs `cleanup` if the process is told to stop; call the result once it's no longer needed. */
export function cleanUpIfInterrupted(cleanup: () => void) {
  if (!interruptions.size) {
    for (const name of INTERRUPTS) {
      process.on(name, interrupted);
    }
  }

  interruptions.add(cleanup);

  return () => {
    interruptions.delete(cleanup);
    if (!interruptions.size) {
      for (const name of INTERRUPTS) {
        process.removeListener(name, interrupted);
      }
    }
  };
}

/**
 * Runs `run` holding the user-level sync lock, after rolling forward any
 * interrupted operation. Nested calls for the same home reuse the lock.
 */
export async function locked<T>(
  runtime: RuntimeContext,
  run: () => Promise<T>,
): Promise<T> {
  runtime = { ...runtime, home: resolve(runtime.cwd, runtime.home) };
  const { home } = runtime;
  if (locks.getStore()?.has(home)) {
    return run();
  }

  const path = barndogPaths(home).syncLock;

  return withPidLock(
    path,
    {
      starting: `Another sync is starting. If an old process crashed, check and remove ${path}`,
      running: "Another BarnDog environment operation is running",
    },
    async () => {
      const release = cleanUpIfInterrupted(() =>
        rmSync(path, { recursive: true, force: true }),
      );

      try {
        return await locks.run(
          new Set([...(locks.getStore() ?? []), home]),
          async () => {
            await recover(runtime);

            return run();
          },
        );
      } finally {
        release();
      }
    },
  );
}
