import type { RuntimeContext } from "../../runtime.js";
import { join } from "node:path";

import {
  hookAdaptPrompt,
  hookSchema,
  type HookAdaptPlace,
  type HookManifest,
} from "@barndog-ai/api-contract";
import { hookMetadata } from "@barndog-ai/api-contract/package";

import { readSettings, SetupRequiredError } from "../../config/settings.js";
import { CliError } from "../../errors.js";
import {
  adapters,
  hookHarnesses,
  isHookHarness,
} from "../../harnesses/registry.js";
import type { Harness, HookHarness } from "../../harnesses/types.js";
import { selectAsset } from "../server/catalog.js";
import { repoForOrigin, selectRepoAsset } from "../workspace/assets.js";
import { LOCAL_ORIGIN } from "../workspace/overlay.js";
import { importedFrom } from "../imports/local.js";

type Implementations = HookManifest["implementations"];

/** Where an agent finds the Hook's files; the folder's origin is filled in here. */
type AdaptPlace =
  | Omit<Extract<HookAdaptPlace, { type: "folder" }>, "origin">
  | Extract<HookAdaptPlace, { type: "workspace" }>;

type AdaptInput = {
  name: string;
  implementations: Implementations;
  targets: readonly HookHarness[];
  place: AdaptPlace;
  /** The repository it was added from, when it still follows it. */
  source?: { url: string; folder: string };
};

/** "Codex", "Codex and Cursor", "Claude Code, Codex or Cursor". */
export function toolNames(tools: readonly Harness[], joiner = "and") {
  const names = tools.map((tool) => adapters[tool].name);

  return names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} ${joiner} ${names.at(-1)}`;
}

/** The shared prompt, with this machine's names for coding tools and the local folder. */
function adaptPrompt(input: AdaptInput) {
  return hookAdaptPrompt({
    ...input,
    // Object.fromEntries types its keys as string; the map covers every harness.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    tools: Object.fromEntries(
      hookHarnesses.map((harness) => [harness, adapters[harness].name]),
    ) as Record<HookHarness, string>,
    place:
      input.place.type === "folder"
        ? { ...input.place, origin: LOCAL_ORIGIN }
        : input.place,
  });
}

async function resolveHook(
  name: string,
  origin: string,
  runtime: RuntimeContext,
) {
  const { home } = runtime;

  const settings = await readSettings(home);
  if (!settings) {
    throw new SetupRequiredError();
  }

  const local = settings.localWorkspace;
  const git = settings.gitWorkspace;
  const shared = Boolean(git || settings.connection);
  const repo = repoForOrigin(settings, runtime, origin);
  if (!repo) {
    const selected = await selectAsset("hook", name, origin, runtime);
    const asset = hookSchema.parse(selected.asset);
    const implementations: Implementations = {};
    for (const row of asset.compatibility) {
      if (row.implementation) {
        implementations[row.harness] = row.implementation;
      }
    }

    return {
      name: asset.name,
      implementations,
      machine: settings.harnesses.filter(isHookHarness),
      place: {
        type: "workspace",
        origin,
        review: "a Suggested Change",
      } satisfies AdaptPlace,
    };
  }

  const asset = selectRepoAsset(await repo.model(), "hook", name, origin);
  const { implementations } = hookMetadata(asset.entries);
  const inFolder = local && (origin === LOCAL_ORIGIN || !shared);

  return {
    name: asset.name,
    implementations,
    machine: settings.harnesses.filter(isHookHarness),
    place: inFolder
      ? ({
          type: "folder",
          path: join(local.path, asset.path),
          shareable: shared,
        } satisfies AdaptPlace)
      : ({
          type: "workspace",
          origin,
          review: "a pull request",
        } satisfies AdaptPlace),
  };
}

/**
 * Hook adaptation guidance; prompt is null and targets are empty when no
 * implementation is missing.
 */
export type Adaptation = {
  name: string;
  /** Tools the Hook has settings for. */
  written: HookHarness[];
  /** Tools to adapt it for; empty when nothing is missing. */
  targets: HookHarness[];
  /** Null when there is nothing to adapt. */
  prompt: string | null;
};

/**
 * Works out which coding tools a Hook doesn't cover and writes the prompt for
 * them. Without `targets`, those are the tools set up on this machine.
 */
export async function adaptHook(
  name: string,
  origin: string,
  targets: readonly HookHarness[] | undefined,
  runtime: RuntimeContext,
): Promise<Adaptation> {
  const hook = await resolveHook(name, origin, runtime);
  const written = hookHarnesses.filter((h) => hook.implementations[h]);
  const covered = targets?.filter((h) => written.includes(h)) ?? [];
  if (covered.length) {
    throw new CliError(
      `${hook.name} already has settings for ${toolNames(covered)}.`,
    );
  }

  const missing = hookHarnesses.filter(
    (h) => (targets ?? hook.machine).includes(h) && !written.includes(h),
  );

  if (!missing.length) {
    return { name: hook.name, written, targets: [], prompt: null };
  }

  const record =
    hook.place.type === "folder"
      ? await importedFrom("hook", hook.name, runtime)
      : null;

  return {
    name: hook.name,
    written,
    targets: missing,
    prompt: adaptPrompt({
      name: hook.name,
      implementations: hook.implementations,
      targets: missing,
      place: hook.place,
      ...(record ? { source: { url: record.url, folder: record.root } } : {}),
    }),
  };
}
