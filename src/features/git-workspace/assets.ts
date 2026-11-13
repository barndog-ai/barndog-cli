import { runtimeRequirements } from "../native/adapters.js";
import type { AssetKind } from "../asset-selection/types.js";
import { hookMetadata } from "@barndog-ai/api-contract/package";
import { CliError } from "../../errors.js";
import { matchesOrigin } from "../collaboration/remote.js";
import { originLabel } from "../environment/names.js";
import type { RepoAsset, WorkspaceModel } from "./format.js";
import { folderSnapshot } from "./snapshot.js";
import { loadWorkspace } from "./format.js";
import { resolve } from "node:path";
import type { Settings } from "../../config/settings.js";
import { openRepoSource } from "../environment/workspace-source.js";
import { LOCAL_ORIGIN, localOverlay } from "./overlay.js";
import { assetNotFound } from "../asset-kinds/index.js";
import { only } from "../../shared/lookup.js";

/** The repo-backed source that answers for an origin, if any. */
export function repoForOrigin(
  settings: Settings,
  home: string,
  origin: string,
) {
  const overlay = localOverlay(settings, home);

  return origin === LOCAL_ORIGIN && overlay
    ? overlay
    : openRepoSource(settings, home, { refresh: "auto" });
}

/** Finds one asset by name and origin, the way cloud commands address assets. */
export function selectRepoAsset(
  model: WorkspaceModel,
  kind: AssetKind,
  name: string,
  origin: string,
): RepoAsset {
  const matches = model.assets.filter(
    (asset) =>
      asset.kind === kind &&
      (asset.id === name || asset.name === name) &&
      (origin === LOCAL_ORIGIN || matchesOrigin(asset.origin, origin, model)),
  );

  const asset = only(matches);
  if (!asset) {
    throw assetNotFound(kind, name, origin);
  }

  if (asset.invalid) {
    throw new CliError(`${asset.path} is invalid: ${asset.invalid}`);
  }

  return asset;
}

export function showRepoAsset(asset: RepoAsset) {
  return {
    id: asset.id,
    kind: asset.kind,
    name: asset.name,
    origin: originLabel(asset.origin),
    path: asset.path,
    version: asset.publishedVersion,
    description: asset.description,
    ...(asset.definition ? { definition: asset.definition } : {}),
    ...(asset.kind === "hook" ? { manifest: hookMetadata(asset.entries) } : {}),
  };
}

export async function repoHookCompatibility(asset: RepoAsset) {
  const manifest = hookMetadata(asset.entries);

  return {
    version: asset.publishedVersion,
    compatibility: await Promise.all(
      (["claude", "codex", "cursor"] as const).map(async (harness) => {
        const implementation = manifest.implementations[harness] ?? null;

        return {
          harness,
          status: implementation?.compatibility ?? ("unsupported" as const),
          declared: true,
          implementation,
          runtimeIssue: implementation
            ? await runtimeRequirements(harness, implementation.requirements)
            : "No implementation for this harness",
        };
      }),
    ),
  };
}

/** Checks a workspace folder without installing anything, for use in repo CI. */
export async function validateFolder(directory: string) {
  const model = await loadWorkspace(await folderSnapshot(resolve(directory)));
  if (model.problems.length) {
    throw new CliError(
      `${model.problems.length} problem${model.problems.length === 1 ? "" : "s"} found:\n${model.problems.map((problem) => `  ${problem.path}: ${problem.reason}`).join("\n")}`,
    );
  }

  return {
    workspace: model.config.name,
    assets: model.assets.length,
    knowledge: model.knowledge.length,
  };
}
