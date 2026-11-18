import { basename, dirname, isAbsolute } from "node:path";
import {
  harnesses,
  skillDirectory,
  nativeFile,
  nativeKinds,
} from "../harnesses/registry.js";
import { z } from "zod";
import { packageKindList } from "./selection.js";
import { NAME, UUID_V4 } from "../shared/patterns.js";
import { barndogPaths } from "./paths.js";
import { readIfExists } from "../shared/files.js";
import { CliError } from "../shared/cli-error.js";

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
  native: z.array(
    z.strictObject({
      id: z.string(),
      kind: z.enum(nativeKinds),
      harness: z.enum(harnesses),
      file: z.string(),
      key: z.string(),
      value: z.record(z.string(), z.unknown()),
    }),
  ),
  installed: z.array(
    z.strictObject({
      id: z.string(),
      kind: z.enum(packageKindList),
      path: z.string(),
      fingerprint: z.string(),
      versionId: z.string(),
    }),
  ),
});

export type Link = z.infer<typeof linkSchema>;

export type State = z.infer<typeof stateSchema>;

/**
 * Reads installation ownership and checks targets against the supplied home;
 * missing state yields no links.
 */
export async function readState(home: string): Promise<State> {
  const path = barndogPaths(home).state;
  const text = await readIfExists(path);
  if (text === null) {
    return { version: 1, links: [], native: [], installed: [] };
  }

  // Without this record BarnDog can't tell its own entries from yours, so
  // nothing is changed until it is repaired.
  const damaged = (cause?: unknown) =>
    new CliError(
      `${path} is damaged, so BarnDog won't change your tools' files.`,
      "Undo any edit to that file. If it can't be repaired, move it aside, remove what BarnDog installed in your tools, then run barndog sync",
      { cause },
    );

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw damaged(error);
  }

  const parsed = stateSchema.safeParse(value);
  if (!parsed.success) {
    throw damaged(parsed.error);
  }

  const state = parsed.data;
  for (const entry of state.native) {
    if (entry.file !== nativeFile(entry.harness, entry.kind, home)) {
      throw damaged();
    }
  }

  for (const entry of state.installed) {
    if (dirname(entry.path) !== barndogPaths(home).installed(entry.kind)) {
      throw damaged();
    }
  }

  const targets = new Set<string>();
  const checked: Link[] = [];
  for (const link of state.links) {
    if (
      dirname(link.target) !== skillDirectory(link.harness, home) ||
      !NAME.test(basename(link.target)) ||
      targets.has(link.target)
    ) {
      throw damaged();
    }

    targets.add(link.target);
    checked.push(link);
  }

  return { ...state, links: checked };
}
