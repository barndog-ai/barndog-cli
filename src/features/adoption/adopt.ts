/**
 * `barndog adopt`: copy assets the user set up in their coding tools into
 * BarnDog's local folder, take the originals out of the tools, and sync so
 * BarnDog's copies install in their place. `undo.ts` puts them back.
 */
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { stringify } from "yaml";

import { barndogPaths } from "../../config/paths.js";
import { readSettings, type LocalWorkspace } from "../../config/settings.js";
import { readState } from "../../config/state.js";
import { CliError, friendlyMessage } from "../../errors.js";
import type { RuntimeContext } from "../../runtime.js";
import { POSIX_MODE } from "../../shared/constants.js";
import { ifExists, writeAtomic } from "../../shared/files.js";
import { defined } from "../../shared/lookup.js";
import { assetKinds } from "../asset-kinds/index.js";
import type { SyncEvent } from "../environment/events.js";
import { synchronize } from "../environment/sync.js";
import { locked } from "../environment/transaction.js";
import { ensureLocalWorkspace } from "../imports/local.js";
import {
  keepLiteralValues,
  literalValues,
  type KeptChoice,
  type McpValue,
} from "../mcps/import.js";
import { writePackage } from "../workspace/directory.js";
import { localRepoSource } from "../workspace/repo-source.js";
import { copyFingerprint, installed } from "./copies.js";
import { takeOut } from "./originals.js";
import { restore } from "./restore.js";
import {
  readAdoptions,
  writeAdoption,
  type Adoption,
  type NativeAssetKind,
} from "./record.js";
import {
  findNativeAssets,
  type AssetRef,
  type FoundAsset,
  type NativeAsset,
  type NativeScan,
} from "./scan.js";

/** One asset an adoption takes over, and whose copy BarnDog installs in its place. */
export type PlannedAsset = NativeAsset & {
  /** The asset whose content BarnDog keeps; another tool's when they differ. */
  source: AssetRef;
};

/**
 * What adopting `keys` takes over: each chosen asset, plus other tools'
 * Skills and MCP servers of the same name, which BarnDog's one copy replaces.
 */
export function adoptionPlan(
  scan: NativeScan,
  keys: readonly string[],
): PlannedAsset[] {
  const byKey = new Map(scan.assets.map((asset) => [asset.key, asset]));
  const unknown = keys.filter((key) => !byKey.has(key));
  if (unknown.length) {
    throw new CliError(
      `${unknown.join(", ")} ${unknown.length === 1 ? "isn't an asset" : "aren't assets"} BarnDog can adopt.`,
      "barndog adopt --dry-run",
    );
  }

  const planned = new Map<string, PlannedAsset>();
  for (const key of keys) {
    const asset = byKey.get(key);
    if (!asset || planned.has(key)) {
      continue;
    }

    const group = [key, ...asset.sameName.map((other) => other.key)];
    const chosen = group.filter((other) => keys.includes(other));
    const differing = chosen.find(
      (other) => other !== key && !byKey.get(other)?.identical,
    );

    if (differing) {
      throw new CliError(
        `${key} and ${differing} are different ${assetKinds[asset.kind].many} with the same name, and BarnDog installs one copy in every tool.`,
        `barndog adopt --only ${key}`,
      );
    }

    for (const member of group) {
      const found = byKey.get(member);
      if (found) {
        planned.set(member, {
          ...found,
          source: { key, harness: asset.harness },
        });
      }
    }
  }

  return [...planned.values()];
}

/** Something to do for one adopted asset. */
type AdoptionNote = {
  kind: NativeAssetKind;
  name: string;
  text: string;
};

/** What `barndog adopt` did. */
export type AdoptionResult = {
  id: string;
  adopted: PlannedAsset[];
  /** Where the originals wait until undo. */
  backup: string;
  /** What to do before an adopted asset works. */
  notes: AdoptionNote[];
  /** The literal values adopted MCP servers held, and which of them BarnDog keeps. */
  values: McpValue[];
  events: SyncEvent[];
  /** A Git or Cloud workspace runs beside the local folder, so `local move` can share what was adopted. */
  canShare: boolean;
};

async function hasSharedWorkspace(home: string) {
  const settings = await readSettings(home);

  return Boolean(settings?.connection ?? settings?.gitWorkspace);
}

/** Same-named copies share one source, so each source's notes appear once. */
function adoptionNotes(
  plan: PlannedAsset[],
  sourceOf: (asset: PlannedAsset) => FoundAsset,
  keep: readonly KeptChoice[],
): Pick<AdoptionResult, "notes" | "values"> {
  const sources = [
    ...new Map(plan.map((asset) => [asset.source.key, asset])).values(),
  ];

  return {
    notes: sources.flatMap((asset) =>
      sourceOf(asset).notes.map((text) => ({
        kind: asset.kind,
        name: asset.name,
        text,
      })),
    ),
    values: sources.flatMap((asset) =>
      literalValues(asset.name, sourceOf(asset).literals, keep),
    ),
  };
}

/** Takes over the chosen assets; on any failure, puts back what it changed. */
export async function adoptNative(
  keys: readonly string[],
  /** The MCP values BarnDog keeps on this machine (see `mcp env`). */
  keep: readonly KeptChoice[],
  runtime: RuntimeContext,
): Promise<AdoptionResult> {
  const { home } = runtime;

  return locked(runtime, async () => {
    const unfinished = (await readAdoptions(home)).find(
      (record) => record.status === "pending",
    );

    if (unfinished) {
      throw new CliError(
        "An earlier adoption didn't finish. Undo it before adopting more.",
        `barndog adopt undo ${unfinished.id}`,
      );
    }

    const { found, skipped } = await findNativeAssets(runtime);
    const plan = adoptionPlan({ assets: found, skipped }, keys);
    if (!plan.length) {
      throw new CliError(
        "Choose at least one asset to adopt.",
        "barndog adopt",
      );
    }

    const workspace = await ensureLocalWorkspace(runtime);
    const id = randomUUID();
    const paths = barndogPaths(home).adoption(id);
    const byKey = new Map(found.map((asset) => [asset.key, asset]));
    const scanned = (key: string) =>
      defined(byKey.get(key), `The scan found no ${key}`);

    const sourceOf = (asset: PlannedAsset) => scanned(asset.source.key);

    const record: Adoption = {
      id,
      createdAt: new Date().toISOString(),
      status: "pending",
      files: [],
      items: plan.map((asset) => {
        const { copy, original } = scanned(asset.key);

        return {
          key: asset.key,
          harness: asset.harness,
          kind: asset.kind,
          name: asset.name,
          description: asset.description,
          copy: join(workspace.path, copy),
          assetId: "",
          fingerprint: "",
          original,
          backup:
            original.type === "folder"
              ? join(paths.skills, asset.harness, asset.name)
              : undefined,
          undone: false,
        };
      }),
    };

    // Undo removes every copy, so none may be there already.
    for (const item of record.items) {
      if ((await ifExists(lstat(item.copy))) !== null) {
        throw new CliError(
          `${item.copy} already exists, so ${item.name} can't be adopted.`,
          "barndog adopt --dry-run",
        );
      }
    }

    // Written before anything changes, so undo can always find what moved.
    await writeAdoption(record, home);
    const values = { forget: async () => {} };

    try {
      const events = await apply(
        { record, plan, sourceOf, workspace, keep, values },
        runtime,
      );

      return {
        id,
        adopted: plan,
        backup: paths.folder,
        ...adoptionNotes(plan, sourceOf, keep),
        events,
        canShare: await hasSharedWorkspace(home),
      };
    } catch (error) {
      await restore(record, record.items, runtime).catch(
        (undoError: unknown) => {
          throw new CliError(
            `Adopting failed (${friendlyMessage(error)}), and putting things back failed too: ${friendlyMessage(undoError)}`,
            `barndog adopt undo ${id}`,
            { cause: error },
          );
        },
      );

      await values.forget();

      throw error;
    }
  });
}

async function apply(
  input: {
    record: Adoption;
    plan: PlannedAsset[];
    sourceOf: (asset: PlannedAsset) => FoundAsset;
    workspace: LocalWorkspace;
    keep: readonly KeptChoice[];
    /** Set once values are kept, to put them back if adopting fails. */
    values: { forget: () => Promise<void> };
  },
  runtime: RuntimeContext,
): Promise<SyncEvent[]> {
  const { home } = runtime;
  const { record, plan, sourceOf, workspace } = input;

  // One copy per name: tools that had the same asset share it.
  const written = new Map<string, string>();
  for (const [index, asset] of plan.entries()) {
    const item = defined(record.items[index], "Each planned asset has an item");
    if (!written.has(item.copy)) {
      await writeCopy(item.copy, sourceOf(asset), runtime);
      written.set(
        item.copy,
        defined(await copyFingerprint(item, runtime), "The copy was written"),
      );
    }

    item.fingerprint = defined(written.get(item.copy), "The copy was written");
  }

  const model = await localRepoSource(workspace, runtime).model();
  for (const item of record.items) {
    const asset = model.assets.find(
      (candidate) => join(workspace.path, candidate.path) === item.copy,
    );

    if (!asset || asset.invalid) {
      throw new CliError(
        `BarnDog couldn't read its copy of ${item.name}: ${asset?.invalid ?? "it's missing"}.`,
      );
    }

    item.assetId = asset.id;
  }

  // Kept by asset ID, which exists only now; saved before the sync writes them.
  // One source per name, and every item of it shares one copy and asset ID.
  const servers = new Map(
    plan.flatMap((asset, index) =>
      asset.kind === "mcp"
        ? [
            [
              asset.source.key,
              {
                id: defined(
                  record.items[index],
                  "Each planned asset has an item",
                ).assetId,
                name: asset.name,
                literals: sourceOf(asset).literals,
              },
            ] as const,
          ]
        : [],
    ),
  );

  input.values.forget = await keepLiteralValues(
    [...servers.values()],
    input.keep,
    runtime,
  );

  // A settings file is saved as the user left it, before BarnDog's first change.
  for (const item of record.items) {
    const { original } = item;
    if (
      original.type === "entry" &&
      !record.files.some((saved) => saved.file === original.file)
    ) {
      const backup = join(
        barndogPaths(home).adoption(record.id).settings,
        `${record.files.length + 1}-${basename(original.file)}`,
      );

      await mkdir(dirname(backup), { recursive: true });
      await copyFile(original.file, backup);
      record.files.push({ file: original.file, backup });
    }
  }

  await writeAdoption(record, home);

  for (const item of record.items) {
    await takeOut(item.harness, item.original, item.backup);
  }

  const events = await synchronize(undefined, runtime, undefined, {
    prompt: false,
  });

  const state = await readState(home);
  const missing = record.items.filter((item) => !installed(item, state));
  if (missing.length) {
    const clashes = events.flatMap((event) =>
      event.type === "clash" &&
      missing.some((item) => item.name === event.skipped.name)
        ? [
            `BarnDog already installs ${event.kind === "skill" ? "a Skill" : "an MCP server"} named ${event.installed.name} from ${event.installed.origin}.`,
          ]
        : [],
    );

    throw new CliError(
      `BarnDog couldn't install ${missing.map((item) => item.key).join(", ")}, so nothing was adopted. ${clashes.join(" ")}`.trim(),
      "Rename yours in its coding tool, then run barndog adopt again",
    );
  }

  record.status = "applied";
  await writeAdoption(record, home);

  return events;
}

async function writeCopy(
  path: string,
  asset: FoundAsset,
  runtime: RuntimeContext,
) {
  const { content } = asset;
  // The workspace's own folders keep default permissions; writeAtomic would make them private.
  await mkdir(dirname(path), { recursive: true });
  if (content.kind === "mcp") {
    await writeAtomic(path, stringify(content.definition), {
      mode: POSIX_MODE.regularFile,
    });

    return;
  }

  await writePackage(path, content.entries, runtime);
}
