/**
 * Taking an asset out of its coding tool and putting it back. Each step checks
 * the disk first, so running it again after a crash does only what is left.
 */
import {
  cp,
  lstat,
  mkdir,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

import { CliError } from "../../errors.js";
import { adapters, type Harness } from "../../harnesses/registry.js";
import { directoryLinkType } from "../../platform.js";
import type { RuntimeContext } from "../../runtime.js";
import { ifExists, readIfExists, writeAtomic } from "../../shared/files.js";
import { asRecord } from "../../shared/values.js";
import { errorCode } from "../../shared/values.js";
import { patchNative, type NativeEntry } from "../native/configuration.js";
import type { Original } from "./record.js";

type EntryOriginal = Extract<Original, { type: "entry" }>;

/** A rename can't cross disks, so a folder on another one is copied, then removed. */
async function moveFolder(from: string, to: string) {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (error) {
    if (errorCode(error) !== "EXDEV") {
      throw error;
    }

    await cp(from, to, { recursive: true, verbatimSymlinks: true });
    await rm(from, { recursive: true, force: true });
  }
}

const nativeEntry = (
  harness: Harness,
  original: EntryOriginal,
): NativeEntry => ({
  id: "adoption",
  kind: original.kind,
  harness,
  file: original.file,
  key: original.key,
  value: original.value,
});

/** Whether the tool's settings file holds this entry exactly as it was adopted. */
function holds(text: string | null, harness: Harness, original: EntryOriginal) {
  if (text === null) {
    return false;
  }

  const data = asRecord(
    original.file.endsWith(".toml") ? parseToml(text) : parseJsonc(text),
  );

  if (original.kind === "mcp") {
    const servers = adapters[harness].mcp.path.reduce<unknown>(
      (value, key) => asRecord(value)[key],
      data,
    );

    return isDeepStrictEqual(asRecord(servers)[original.key], original.value);
  }

  const list = asRecord(data.hooks)[original.key];

  return (
    Array.isArray(list) &&
    list.some((entry) => isDeepStrictEqual(entry, original.value))
  );
}

/** Takes an asset out of its tool; a Skill folder moves to `backup`. */
export async function takeOut(
  harness: Harness,
  original: Original,
  backup: string | undefined,
) {
  switch (original.type) {
    case "folder": {
      if (!backup) {
        throw new Error("A Skill folder is adopted without a backup path");
      }

      if ((await ifExists(lstat(original.path))) !== null) {
        await moveFolder(original.path, backup);
      }

      return;
    }

    case "link": {
      if ((await ifExists(lstat(original.path))) !== null) {
        await unlink(original.path);
      }

      return;
    }

    case "entry": {
      const text = await readIfExists(original.file);
      if (holds(text, harness, original)) {
        await writeAtomic(
          original.file,
          patchNative(text, [nativeEntry(harness, original)], []),
        );
      }

      return;
    }
  }
}

/** Puts an asset back where it was, refusing to replace anything that took its place. */
export async function putBack(
  harness: Harness,
  original: Original,
  backup: string | undefined,
  runtime: RuntimeContext,
) {
  const occupied = (path: string) =>
    new CliError(
      `${path} exists again, so BarnDog can't put the adopted copy back there.`,
      "Move it aside, then run barndog adopt undo again",
    );

  switch (original.type) {
    case "folder": {
      const saved = backup && (await ifExists(lstat(backup)));
      if (!backup || !saved) {
        return;
      }

      if ((await ifExists(lstat(original.path))) !== null) {
        throw occupied(original.path);
      }

      await moveFolder(backup, original.path);

      return;
    }

    case "link": {
      const existing = await ifExists(lstat(original.path));
      if (existing) {
        if (
          existing.isSymbolicLink() &&
          (await readlink(original.path)) === original.target
        ) {
          return;
        }

        throw occupied(original.path);
      }

      await mkdir(dirname(original.path), { recursive: true });
      await symlink(
        original.target,
        original.path,
        directoryLinkType(runtime.platform),
      );

      return;
    }

    case "entry": {
      const text = await readIfExists(original.file);
      if (!holds(text, harness, original)) {
        await writeAtomic(
          original.file,
          patchNative(text, [], [nativeEntry(harness, original)]),
        );
      }

      return;
    }
  }
}
