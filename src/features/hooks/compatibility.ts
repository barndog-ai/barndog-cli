import type { RuntimeContext } from "../../runtime.js";
import { hookSchema } from "@barndog-ai/api-contract";
import { readSettings } from "../../config/settings.js";
import { selectAsset } from "../server/catalog.js";
import { repoForOrigin, selectRepoAsset } from "../workspace/assets.js";
import { runtimeRequirements } from "../native/adapters.js";
import { hookHarnesses } from "../../harnesses/registry.js";
import { hookMetadata } from "@barndog-ai/api-contract/package";
import type { RepoAsset } from "../workspace/format.js";
import type { HookCompatibility } from "./types.js";

/**
 * What a Hook's current version declares for each coding tool BarnDog manages
 * here, and whether this machine has what each implementation needs to run.
 */
export async function hookCompatibility(
  name: string,
  origin: string,
  runtime: RuntimeContext,
): Promise<HookCompatibility> {
  const { home } = runtime;

  const settings = await readSettings(home);
  const managed = (result: HookCompatibility): HookCompatibility =>
    settings
      ? {
          ...result,
          compatibility: result.compatibility.filter((row) =>
            settings.harnesses.includes(row.harness),
          ),
        }
      : result;

  const repo = settings && repoForOrigin(settings, runtime, origin);
  if (repo) {
    return managed(
      await repoHookCompatibility(
        selectRepoAsset(await repo.model(), "hook", name, origin),
        runtime,
      ),
    );
  }

  const selected = await selectAsset("hook", name, origin, runtime);
  const asset = hookSchema.parse(selected.asset);

  return managed({
    version: asset.version.number,
    compatibility: await Promise.all(
      asset.compatibility.map(async (row) => ({
        ...row,
        runtimeIssue: row.implementation
          ? await runtimeRequirements(
              row.harness,
              row.implementation.requirements,
              runtime,
            )
          : "No implementation for this harness",
      })),
    ),
  });
}

/** What a Git or local workspace Hook declares for each coding tool, and what this machine lacks. */
async function repoHookCompatibility(
  asset: RepoAsset,
  runtime: RuntimeContext,
): Promise<HookCompatibility> {
  const manifest = hookMetadata(asset.entries);

  return {
    version: asset.publishedVersion,
    compatibility: await Promise.all(
      hookHarnesses.map(async (harness) => {
        const implementation = manifest.implementations[harness] ?? null;

        return {
          harness,
          status: implementation?.compatibility ?? ("unsupported" as const),
          declared: true,
          implementation,
          runtimeIssue: implementation
            ? await runtimeRequirements(
                harness,
                implementation.requirements,
                runtime,
              )
            : "No implementation for this harness",
        };
      }),
    ),
  };
}
