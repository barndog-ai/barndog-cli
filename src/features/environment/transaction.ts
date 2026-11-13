import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { packageFingerprint } from "@barndog-ai/api-contract/package";
import { settingsPath } from "../../config/settings.js";
import { skillDirectory, harnesses } from "../../harnesses/registry.js";
import { nativeFile } from "../native/configuration.js";
import { z } from "zod";
import { connectionContext } from "../skills/remote.js";
import type { JournalIdentity } from "./source.js";
import { NAME } from "../../shared/patterns.js";
import {
  desiredEntries,
  installedRoot,
  mirrorTree,
  treeFingerprint,
} from "./installed.js";
import { errorCode } from "../../errors.js";

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

export async function fileText(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Refusing non-regular configuration file: ${path}`);
    }

    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function linkTarget(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink()) {
      throw new Error(
        `Existing unmanaged or externally changed Skill: ${path}`,
      );
    }

    return resolve(dirname(path), await readlink(path));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function atomicFile(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

function validateWrites(writes: Write[], home: string) {
  const files = new Set([
    settingsPath(home),
    join(home, ".barndog/state.json"),
    ...harnesses.flatMap((h) => [
      nativeFile(h, "mcp", home),
      nativeFile(h, "hook", home),
    ]),
  ]);

  const paths = new Set<string>();
  for (const write of writes) {
    if (paths.has(write.path) || resolve(write.path) !== write.path) {
      throw new Error("Invalid or duplicate sync destination");
    }

    paths.add(write.path);
    if (write.kind === "tree") {
      if (
        ![installedRoot(home, "skill"), installedRoot(home, "hook")].includes(
          dirname(write.path),
        ) ||
        !NAME.test(basename(write.path)) ||
        (write.source !== null && !isAbsolute(write.source)) ||
        (write.after !== null) !== (write.source !== null) ||
        (write.rename !== null && !NAME.test(write.rename))
      ) {
        throw new Error("Invalid sync journal destination; refusing recovery");
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
      throw new Error("Invalid sync journal destination; refusing recovery");
    }
  }
}

async function current(write: Write) {
  if (write.kind === "file") {
    return fileText(write.path);
  }

  if (write.kind === "link") {
    return linkTarget(write.path);
  }

  return treeFingerprint(write.path);
}

async function applyTree(write: Extract<Write, { kind: "tree" }>) {
  if (write.source === null) {
    await rm(write.path, { recursive: true, force: true });

    return;
  }

  // A folder kept in place has no other copy to restore; the next sync reinstalls it.
  if (write.source === write.path) {
    return;
  }

  const entries = await desiredEntries(write.source, write.rename);
  if (packageFingerprint(entries) !== write.after) {
    throw new Error(
      `Cached package changed before installation: ${write.source}`,
    );
  }

  await mirrorTree(write.path, entries);
}

async function apply(
  writes: Write[],
  home: string,
  checkpoint?: (index: number) => Promise<void>,
  recovering = false,
) {
  validateWrites(writes, home);
  // Check the entire recovery plan before writing any remaining destination.
  for (const write of writes) {
    // An interrupted in-place copy leaves a BarnDog-owned folder half written.
    if (write.kind === "tree" && recovering) {
      continue;
    }

    const value = await current(write);
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
      throw new Error(
        `Sync destination changed; preserve your edits before recovery: ${write.path}`,
      );
    }
  }

  for (const [index, write] of writes.entries()) {
    const value = await current(write);
    if (value === write.after) {
      continue;
    }

    if (write.kind === "tree") {
      if (value !== write.before && !recovering) {
        throw new Error(`Sync destination changed: ${write.path}`);
      }

      await applyTree(write);
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
      throw new Error(`Sync destination changed: ${write.path}`);
    }

    await mkdir(dirname(write.path), { recursive: true, mode: 0o700 });
    if (write.kind === "file") {
      if (write.after === null) {
        await unlink(write.path);
      } else {
        await atomicFile(write.path, write.after);
      }
    } else {
      if (value !== null) {
        await unlink(write.path);
      }

      if (write.after !== null) {
        await symlink(write.after, write.path, "dir");
      }
    }

    await checkpoint?.(index);
  }
}

export async function recover(home: string) {
  const path = join(home, ".barndog/pending-sync.json");
  const text = await fileText(path);

  if (text === null) {
    return false;
  }

  const journal = journalSchema.parse(JSON.parse(text));
  if (journal.connection) {
    const actual = await connectionContext(journal.connection.server, home);
    if (
      actual.organizationId !== journal.connection.organizationId ||
      actual.developerId !== journal.connection.developerId
    ) {
      throw new Error("Sync recovery belongs to another identity");
    }
  }

  await apply(journal.writes, home, undefined, true);
  await unlink(path);

  return true;
}

export async function transact(
  home: string,
  writes: Write[],
  identity?: JournalIdentity,
  checkpoint?: (index: number) => Promise<void>,
) {
  writes = writes.filter((w) => w.before !== w.after);
  if (!writes.length) {
    return;
  }

  validateWrites(writes, home);
  const config = writes.find((w) => w.path === settingsPath(home));
  if (config?.before) {
    const backup = join(
      home,
      ".barndog/migrations",
      `config-${createHash("sha256").update(config.before).digest("hex")}.yaml`,
    );

    const previous = await fileText(backup);
    if (previous === null) {
      await atomicFile(backup, config.before);
    } else if (previous !== config.before) {
      throw new Error("Configuration migration backup was changed");
    }
  }

  const path = join(home, ".barndog/pending-sync.json");
  await atomicFile(
    path,
    JSON.stringify(
      identity && "workspaceId" in identity
        ? { version: 1, writes, workspaceId: identity.workspaceId }
        : { version: 1, writes, connection: identity },
    ),
  );

  await apply(writes, home, checkpoint);
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

export async function locked<T>(
  home: string,
  run: () => Promise<T>,
): Promise<T> {
  home = resolve(home);
  if (locks.getStore()?.has(home)) {
    return run();
  }

  const path = join(home, ".barndog/sync.lock");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await mkdir(path);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }

    const pid = Number(
      await readFile(join(path, "pid"), "utf8").catch(() => "0"),
    );

    if (!pid) {
      throw new Error(
        `Another sync is starting. If an old process crashed, check and remove ${path}`,
        { cause: error },
      );
    }

    try {
      process.kill(pid, 0);
    } catch (failure) {
      if (errorCode(failure) !== "ESRCH") {
        throw failure;
      }

      await rm(path, { recursive: true });

      return locked(home, run);
    }

    throw new Error("Another BarnDog environment operation is running", {
      cause: error,
    });
  }

  const release = cleanUpIfInterrupted(() =>
    rmSync(path, { recursive: true, force: true }),
  );

  try {
    await writeFile(join(path, "pid"), String(process.pid), { mode: 0o600 });

    return await locks.run(
      new Set([...(locks.getStore() ?? []), home]),
      async () => {
        await recover(home);

        return run();
      },
    );
  } finally {
    release();
    await rm(path, { recursive: true, force: true });
  }
}
