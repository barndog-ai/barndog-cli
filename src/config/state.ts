import { readFile, readlink } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import { harnesses, skillDirectory } from "../harnesses/registry.js";
import { treeFingerprint } from "../features/environment/installed.js";
import { isRecord } from "../shared/values.js";
import { z } from "zod";
import { nativeFile } from "../features/native/configuration.js";
import { installedRoot } from "../features/environment/installed.js";
import { packageKindList } from "../features/asset-kinds/index.js";
import { NAME, UUID_V4 } from "../shared/patterns.js";

const linkSchema = z.object({
  id: z.string().regex(UUID_V4),
  harness: z.enum(harnesses),
  source: z.string().refine(isAbsolute),
  target: z.string(),
});

/** The complete persisted installation ownership journal. */
const stateSchema = z.looseObject({
  version: z.literal(1),
  links: z.array(linkSchema),
  native: z
    .array(
      z.strictObject({
        id: z.string(),
        kind: z.enum(["mcp", "hook", "knowledge", "sync"]),
        harness: z.enum(harnesses),
        file: z.string(),
        key: z.string(),
        value: z.record(z.string(), z.unknown()),
      }),
    )
    .default([]),
  installed: z
    .array(
      z.strictObject({
        id: z.string(),
        kind: z.enum(packageKindList),
        path: z.string(),
        fingerprint: z.string(),
        versionId: z.string().optional(),
      }),
    )
    .default([]),
});

export type Link = z.infer<typeof linkSchema>;

export type State = z.infer<typeof stateSchema>;

/**
 * Older versions could record two assets at one target. Only one can be real, so
 * keep the link the target actually points to, then the one whose copy is on disk.
 */
async function withoutRepeatedLinks(
  links: Link[],
  installed: State["installed"],
) {
  const score = async (link: Link) => {
    const actual = await readlink(link.target).catch(() => null);
    const entry = installed.find(
      (item) => item.id === link.id && item.path === link.source,
    );

    return (
      (actual === link.source ? 2 : 0) +
      (entry?.fingerprint === (await treeFingerprint(link.source)) ? 1 : 0)
    );
  };

  const kept: Link[] = [];
  for (const link of links) {
    const index = kept.findIndex((other) => other.target === link.target);

    const held = kept[index];
    if (!held) {
      kept.push(link);
      continue;
    }

    if ((await score(link)) > (await score(held))) {
      kept[index] = link;
    }
  }

  return kept;
}

/**
 * Reads installation ownership and checks targets against the supplied home;
 * missing state yields no links.
 */
export async function readState(path: string, home: string): Promise<State> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return stateSchema.parse({ version: 1, links: [] });
    }

    throw error;
  }

  const parsed = stateSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      "Invalid installation state; refusing to modify harness files",
      { cause: parsed.error },
    );
  }

  const state = parsed.data;
  for (const entry of state.native) {
    if (entry.file !== nativeFile(entry.harness, entry.kind, home)) {
      throw new Error("Invalid native installation state");
    }
  }

  for (const entry of state.installed) {
    if (dirname(entry.path) !== installedRoot(home, entry.kind)) {
      throw new Error("Invalid installed package state");
    }
  }

  const links = await withoutRepeatedLinks(state.links, state.installed);
  const targets = new Set<string>();
  const checked: Link[] = [];
  for (const link of links) {
    if (
      dirname(link.target) !== skillDirectory(link.harness, home) ||
      !NAME.test(basename(link.target)) ||
      targets.has(link.target)
    ) {
      throw new Error(
        "Invalid installation state; refusing to modify harness files",
      );
    }

    targets.add(link.target);
    checked.push(link);
  }

  return { ...state, links: checked };
}
