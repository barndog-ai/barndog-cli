import type { RuntimeContext } from "../../runtime.js";
import { hookSchema } from "@barndog-ai/api-contract";
import type { Hook } from "../asset-kinds/index.js";
import { readSettings } from "../../config/settings.js";
import { selectAsset } from "../server/catalog.js";
import { repoForOrigin, selectRepoAsset } from "../workspace/assets.js";
import {
  missingRequirements,
  skipReason,
  type HookRequirements,
  type MissingRequirement,
} from "../native/requirements.js";
import { hookHarnesses } from "../../harnesses/registry.js";
import { hookMetadata } from "@barndog-ai/api-contract/package";
import type { RepoAsset } from "../workspace/format.js";
import type { HookCompatibility } from "./types.js";
import type { HookHarness } from "../../harnesses/types.js";

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
  const repo = settings && repoForOrigin(settings, runtime, origin);
  if (repo) {
    return repoHookCompatibility(
      selectRepoAsset(await repo.model(), "hook", name, origin),
      runtime,
    );
  }

  const selected = await selectAsset("hook", name, origin, runtime);

  return cloudHookCompatibility(hookSchema.parse(selected.asset), runtime);
}

/** Only the tools this machine has BarnDog manage, once it is set up. */
async function managed(
  result: HookCompatibility,
  runtime: RuntimeContext,
): Promise<HookCompatibility> {
  const settings = await readSettings(runtime.home);

  return settings
    ? {
        ...result,
        compatibility: result.compatibility.filter((row) =>
          settings.harnesses.includes(row.harness),
        ),
      }
    : result;
}

/** What a Cloud Hook declares for each coding tool, and what this machine lacks. */
export async function cloudHookCompatibility(
  asset: Hook,
  runtime: RuntimeContext,
): Promise<HookCompatibility> {
  return managed(
    {
      version: asset.version.number,
      compatibility: await Promise.all(
        asset.compatibility.map(async (row) => ({
          ...row,
          ...(await readiness(row.harness, row.implementation, runtime)),
        })),
      ),
    },
    runtime,
  );
}

/** What a Git or local workspace Hook declares for each coding tool, and what this machine lacks. */
export async function repoHookCompatibility(
  asset: RepoAsset,
  runtime: RuntimeContext,
): Promise<HookCompatibility> {
  const manifest = hookMetadata(asset.entries);

  return managed(
    {
      version: asset.publishedVersion,
      compatibility: await Promise.all(
        hookHarnesses.map(async (harness) => {
          const implementation = manifest.implementations[harness] ?? null;

          return {
            harness,
            status: implementation?.compatibility ?? ("unsupported" as const),
            declared: true,
            implementation,
            ...(await readiness(harness, implementation, runtime)),
          };
        }),
      ),
    },
    runtime,
  );
}

/** What an implementation lacks on this machine, typed and in words. */
async function readiness(
  harness: HookHarness,
  implementation: { requirements: HookRequirements } | null,
  runtime: RuntimeContext,
): Promise<{
  missingRequirements: MissingRequirement[];
  runtimeIssue: string | null;
}> {
  if (!implementation) {
    return {
      missingRequirements: [],
      runtimeIssue: skipReason(harness, { type: "no-implementation" }),
    };
  }

  const missing = await missingRequirements(
    harness,
    implementation.requirements,
    runtime,
  );

  const [first] = missing;

  return {
    missingRequirements: missing,
    runtimeIssue: first
      ? skipReason(harness, { type: "missing-requirement", requirement: first })
      : null,
  };
}
