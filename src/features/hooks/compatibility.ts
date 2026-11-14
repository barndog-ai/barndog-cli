import { homedir } from "node:os";
import { hookSchema } from "@barndog-ai/api-contract";
import { readSettings } from "../../config/settings.js";
import { selectAsset } from "../server/catalog.js";
import { repoForOrigin, selectRepoAsset } from "../workspace/assets.js";
import { runtimeRequirements } from "../native/adapters.js";
import { hookMetadata } from "@barndog-ai/api-contract/package";
import type { RepoAsset } from "../workspace/format.js";
import type { HookCompatibility } from "./types.js";

/**
 * What a Hook's current version declares for each coding tool, and whether
 * this machine has what each implementation needs to run.
 */
export async function hookCompatibility(
  name: string,
  origin: string,
  home = homedir(),
): Promise<HookCompatibility> {
  const settings = await readSettings(home);
  const repo = settings && repoForOrigin(settings, home, origin);
  if (repo) {
    return repoHookCompatibility(
      selectRepoAsset(await repo.model(), "hook", name, origin),
    );
  }

  const selected = await selectAsset("hook", name, origin, home);
  const asset = hookSchema.parse(selected.asset);

  return {
    version: asset.version.number,
    compatibility: await Promise.all(
      asset.compatibility.map(async (row) => ({
        ...row,
        runtimeIssue: row.implementation
          ? await runtimeRequirements(
              row.harness,
              row.implementation.requirements,
            )
          : "No implementation for this harness",
      })),
    ),
  };
}

/** What a Git or local workspace Hook declares for each coding tool, and what this machine lacks. */
async function repoHookCompatibility(
  asset: RepoAsset,
): Promise<HookCompatibility> {
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
