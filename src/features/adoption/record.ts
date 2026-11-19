/**
 * The record of one `barndog adopt`, kept at
 * `~/.barndog/adoptions/<id>/record.json` with the originals it moved aside.
 * Undo reads it to put everything back, and checks each step against the disk
 * so it can finish an adoption that stopped halfway.
 */
import { readdir } from "node:fs/promises";

import { z } from "zod";

import { barndogPaths } from "../../config/paths.js";
import { CliError } from "../../errors.js";
import { harnesses } from "../../harnesses/registry.js";
import { ifExists, readIfExists, writeAtomic } from "../../shared/files.js";
import { UUID_V4 } from "../../shared/patterns.js";

/** The kinds of asset a coding tool keeps that BarnDog can adopt. */
const nativeAssetKinds = ["skill", "mcp", "hook"] as const;

export type NativeAssetKind = (typeof nativeAssetKinds)[number];

const originalSchema = z.discriminatedUnion("type", [
  /** A Skill folder of the tool's own, moved into the adoption's folder. */
  z.strictObject({ type: z.literal("folder"), path: z.string() }),
  /** A link the user made to a Skill kept elsewhere; its target is never touched. */
  z.strictObject({
    type: z.literal("link"),
    path: z.string(),
    target: z.string(),
  }),
  /** An MCP server or one hook event entry in a tool's settings file, as it was written there. */
  z.strictObject({
    type: z.literal("entry"),
    kind: z.enum(["mcp", "hook"]),
    file: z.string(),
    /** The MCP server's name, or the hook's event. */
    key: z.string(),
    value: z.record(z.string(), z.unknown()),
  }),
]);

/** Where an asset was before BarnDog adopted it. */
export type Original = z.infer<typeof originalSchema>;

const itemSchema = z.strictObject({
  /** `claude/mcp/github`, as `--only` names it. */
  key: z.string(),
  harness: z.enum(harnesses),
  kind: z.enum(nativeAssetKinds),
  name: z.string(),
  description: z.string(),
  /** BarnDog's copy in the local folder; tools that had the same name share it. */
  copy: z.string(),
  assetId: z.string(),
  /** The copy as adopted, so undo can tell whether it was edited since. */
  fingerprint: z.string(),
  original: originalSchema,
  /** Where a moved Skill folder waits until undo puts it back. */
  backup: z.string().optional(),
  undone: z.boolean(),
});

export type AdoptedItem = z.infer<typeof itemSchema>;

const recordSchema = z.looseObject({
  id: z.string().regex(UUID_V4),
  createdAt: z.string(),
  /** `pending` until every step finished; undo can finish or reverse one. */
  status: z.enum(["pending", "applied", "undone"]),
  /** Copies of each settings file taken before BarnDog first changed it. */
  files: z.array(z.strictObject({ file: z.string(), backup: z.string() })),
  items: z.array(itemSchema),
});

export type Adoption = z.infer<typeof recordSchema>;

const recordFile = (id: string, home: string) =>
  barndogPaths(home).adoption(id).record;

export async function writeAdoption(record: Adoption, home: string) {
  await writeAtomic(
    recordFile(record.id, home),
    JSON.stringify(record, null, 2) + "\n",
  );
}

async function readAdoption(id: string, home: string): Promise<Adoption> {
  // Only an ID BarnDog made names a folder, so `../x` can't reach elsewhere.
  const file = UUID_V4.test(id) ? recordFile(id, home) : null;
  const text = file === null ? null : await readIfExists(file);
  if (file === null || text === null) {
    throw new CliError(`There's no adoption ${id}.`, "barndog adopt list");
  }

  try {
    return recordSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new CliError(
      `${file} is damaged, so BarnDog can't tell what that adoption moved.`,
      "Undo any edit to that file, then try again",
      { cause: error },
    );
  }
}

/** Every adoption on this machine, newest first. */
export async function readAdoptions(home: string): Promise<Adoption[]> {
  const folders = (await ifExists(readdir(barndogPaths(home).adoptions))) ?? [];

  const records = await Promise.all(
    folders
      .filter((name) => UUID_V4.test(name))
      .map((id) => readAdoption(id, home)),
  );

  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The adoption `id` names, or the newest one that still has something to undo. */
export async function findAdoption(
  id: string | undefined,
  home: string,
): Promise<Adoption> {
  if (id) {
    return readAdoption(id, home);
  }

  const open = (await readAdoptions(home)).find(
    (record) => record.status !== "undone",
  );

  if (!open) {
    throw new CliError("There's nothing to undo.", "barndog adopt list");
  }

  return open;
}

/**
 * An adopted asset as commands show it. It leaves out the settings entry it
 * came from, which may hold a literal API key.
 */
export type AdoptedAsset = {
  key: string;
  harness: AdoptedItem["harness"];
  kind: NativeAssetKind;
  name: string;
  description: string;
  /** The folder, link or settings file it came from. */
  location: string;
  copy: string;
  undone: boolean;
};

export type AdoptionSummary = {
  id: string;
  createdAt: string;
  status: Adoption["status"];
  items: AdoptedAsset[];
};

export function summary(record: Adoption): AdoptionSummary {
  return {
    id: record.id,
    createdAt: record.createdAt,
    status: record.status,
    items: record.items.map((item) => ({
      key: item.key,
      harness: item.harness,
      kind: item.kind,
      name: item.name,
      description: item.description,
      location:
        item.original.type === "entry"
          ? item.original.file
          : item.original.path,
      copy: item.copy,
      undone: item.undone,
    })),
  };
}

/** The adoptions on this machine, newest first, as `adopt list` shows them. */
export async function listAdoptions(home: string): Promise<AdoptionSummary[]> {
  return (await readAdoptions(home)).map(summary);
}
