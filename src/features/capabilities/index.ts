import { inspect } from "../inspection/index.js";
import { doctor } from "../doctor/index.js";
import { environmentOperation } from "../environment/operations.js";
import { hookSchema } from "@barndog-ai/api-contract";
import { runtimeRequirements } from "../native/adapters.js";
import { homedir } from "node:os";
import type { AssetKind } from "../asset-selection/types.js";
import type { Harness } from "../../harnesses/types.js";
import {
  knowledgeGet,
  knowledgeList,
  knowledgeProblems,
} from "../knowledge/index.js";
import { writeMcp, authenticateMcp, mcpVersions } from "../mcps/index.js";
import { developerAssets, developers, promote } from "../discovery/index.js";
import { selectAsset } from "../environment/remote.js";
import { testHook } from "../hooks/test.js";
import { gitOperation, type GitOptions } from "../git-hosts/index.js";
import { readSettings } from "../../config/settings.js";
import {
  repoForOrigin,
  repoHookCompatibility,
  selectRepoAsset,
  showRepoAsset,
  validateFolder,
} from "../git-workspace/assets.js";
import { migrate } from "../git-workspace/migrate.js";
import { listLocalAssets, moveLocalAssets } from "../git-workspace/move.js";
import { LOCAL_ORIGIN } from "../git-workspace/overlay.js";
import { updateImported } from "../imports/local.js";
import { adaptHook } from "../hooks/adapt.js";

export type CapabilityOptions = Omit<GitOptions, "kind" | "event"> & {
  kind?: AssetKind;
  file?: string;
  target?: string;
  newName?: string;
  search?: string;
  harness?: Harness;
  targets?: Harness[];
  input?: string;
  handler?: number;
  timeout?: number;
  event?: string;
  always?: boolean;
  directory?: string;
  server?: string;
  dryRun?: boolean;
  names?: string[];
  to?: string;
  as?: string;
  repo?: string;
  force?: boolean;
};

export async function capability(
  action: string,
  options: CapabilityOptions = {},
  home = homedir(),
): Promise<unknown> {
  if (action === "validate") return validateFolder(options.directory ?? ".");
  if (action === "local-list") return listLocalAssets(home);
  if (action === "local-move")
    return moveLocalAssets(
      {
        names: options.names,
        to: options.to,
        as: options.as,
        repo: options.repo,
        server: options.server,
      },
      home,
    );
  if (action === "imports-update")
    return updateImported(
      options.kind as "skill" | "hook",
      options.name,
      { force: options.force, dryRun: options.dryRun },
      home,
    );
  if (action === "promote" && options.origin === LOCAL_ORIGIN)
    return moveLocalAssets(
      {
        names: [options.name!],
        kind: options.kind,
        to: options.target,
        as: options.newName === options.name ? undefined : options.newName,
      },
      home,
    );
  if (action === "migrate")
    return migrate({ server: options.server!, dryRun: options.dryRun }, home);
  if (action === "show" || action === "hooks-compatibility") {
    const settings = await readSettings(home);
    const repo = settings && repoForOrigin(settings, home, options.origin!);
    if (repo) {
      const asset = selectRepoAsset(
        await repo.model(),
        action === "show" ? options.kind! : "hook",
        options.name!,
        options.origin!,
      );
      return action === "show"
        ? showRepoAsset(asset)
        : repoHookCompatibility(asset);
    }
  }
  if (["whoami", "open", "repo-status"].includes(action))
    return inspect(action, home);
  if (action === "doctor") return doctor(home);
  if (action.startsWith("github-"))
    return gitOperation(action.slice(7), options as GitOptions, home);
  if (action === "knowledge-enable" || action === "knowledge-disable")
    return environmentOperation(action, {}, home);
  if (action === "knowledge-list") return knowledgeList(home, options.always);
  if (action === "knowledge-problems") return knowledgeProblems(home);
  if (action === "knowledge-get") return knowledgeGet(options.name!, home);
  if (action === "mcp-create" || action === "mcp-update")
    return writeMcp(
      options.name!,
      options.origin!,
      options.file!,
      home,
      options.key,
      action === "mcp-update" ? options.expectedVersion : undefined,
    );
  if (action === "mcp-auth")
    return authenticateMcp(
      options.name!,
      options.origin!,
      options.harness!,
      home,
    );
  if (action === "mcp-versions")
    return mcpVersions(options.name!, options.origin!, home);
  if (action === "show")
    return (
      await selectAsset(options.kind!, options.name!, options.origin!, home)
    ).asset;
  if (action === "hooks-compatibility") {
    const selected = await selectAsset(
      "hook",
      options.name!,
      options.origin!,
      home,
    );
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
  if (action === "hooks-adapt")
    return adaptHook(options.name!, options.origin!, options.targets, home);
  if (action === "hooks-test")
    return testHook(
      options.name!,
      options.origin!,
      {
        harness: options.harness!,
        input: options.input!,
        event: options.event as string | undefined,
        handler: options.handler,
        timeout: options.timeout,
      },
      home,
    );
  if (action === "developers-list") return developers(options.search, home);
  if (action === "developers-assets")
    return developerAssets(options.name!, options.search, home);
  if (action === "promote" || action === "fork")
    return promote(
      options.kind!,
      options.name!,
      options.origin!,
      options.target!,
      options.newName!,
      home,
      action === "fork",
      options.key,
    );
  throw new Error(`Unknown capability: ${action}`);
}
