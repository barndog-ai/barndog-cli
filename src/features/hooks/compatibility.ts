import { homedir } from "node:os";
import { hookSchema } from "@barndog-ai/api-contract";
import { readSettings } from "../../config/settings.js";
import { selectAsset } from "../environment/remote.js";
import {
  repoForOrigin,
  repoHookCompatibility,
  selectRepoAsset,
} from "../git-workspace/assets.js";
import { runtimeRequirements } from "../native/adapters.js";

/**
 * What a Hook's current version declares for each coding tool, and whether
 * this machine has what each implementation needs to run.
 */
export async function hookCompatibility(
  name: string,
  origin: string,
  home = homedir(),
) {
  const settings = await readSettings(home);
  const repo = settings && repoForOrigin(settings, home, origin);
  if (repo)
    return repoHookCompatibility(
      selectRepoAsset(await repo.model(), "hook", name, origin),
    );
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
