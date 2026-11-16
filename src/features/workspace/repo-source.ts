import type { RuntimeContext } from "../../runtime.js";
import {
  POSIX_MODE,
  HOURS_PER_DAY,
  MILLISECONDS_PER_MINUTE,
  MINUTES_PER_HOUR,
} from "../../shared/constants.js";

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { GitWorkspace, LocalWorkspace } from "../../config/settings.js";
import { CliError } from "../../errors.js";
import type { AssetReference } from "../asset-selection/types.js";
import { storePackage } from "./packages.js";
import type { WorkspaceSource, SourceOptions } from "./source.js";
import {
  loadWorkspace,
  type RepoAsset,
  type WorkspaceModel,
  NAME_RULE,
} from "./format.js";
import { git, GitError, gitReason, gitText } from "./git.js";
import { folderSnapshot, gitSnapshot, type Snapshot } from "./snapshot.js";
import { defined } from "../../shared/lookup.js";
import { z } from "zod";
import { readJsonIfExists, writeAtomic } from "../../shared/files.js";
import { barndogPaths } from "../../config/paths.js";

/** Display ages of at least two days in days. */
const AGE_IN_DAYS_THRESHOLD_HOURS = 48;

/** A workspace read from files; adds what cloud answers through other endpoints. */
export type RepoSource = WorkspaceSource & {
  model(): Promise<WorkspaceModel>;
  label: string;
};

function repoSource(
  backend: {
    cacheKey: string;
    workspaceId: string;
    label: string;
    open(): Promise<Snapshot>;
    notices(): readonly string[];
    localOnly?: boolean;
  },
  runtime: RuntimeContext,
): RepoSource {
  let loading: Promise<WorkspaceModel> | undefined;
  const model = () =>
    (loading ??= backend.open().then((snapshot) =>
      loadWorkspace(snapshot, backend.workspaceId, {
        localOnly: backend.localOnly ?? false,
      }),
    ));

  const find = async (reference: AssetReference): Promise<RepoAsset> => {
    const asset = (await model()).assets.find((a) => a.id === reference.id);
    if (!asset || asset.publishedVersion !== reference.publishedVersion) {
      throw new CliError("The catalog changed while syncing.", "barndog sync");
    }

    if (asset.invalid) {
      throw new CliError(`${asset.path} is invalid: ${asset.invalid}`);
    }

    return asset;
  };

  return {
    cacheKey: backend.cacheKey,
    journal: { workspaceId: backend.workspaceId },
    label: backend.label,
    model,
    catalog: async () => (await model()).catalog,
    invalidAssets: async () => (await model()).invalid,
    notices: () => backend.notices(),
    warnings: async () => {
      const { invalidKnowledge, problems } = await model();

      return [
        ...invalidKnowledge.map(
          (problem) =>
            `Knowledge file ${problem.path} was skipped: ${problem.reason}`,
        ),
        ...problems
          .filter((problem) => problem.reason === NAME_RULE)
          .map(
            (problem) =>
              `${problem.path} was skipped: ${problem.reason}. Rename it to deliver it.`,
          ),
      ];
    },
    packageFolder: async (kind, reference) => {
      const asset = await find(reference);

      return storePackage(
        kind,
        {
          id: asset.id,
          name: asset.name,
          revision: asset.publishedVersion,
        },
        { key: backend.cacheKey, runtime },
        () => Promise.resolve(asset.entries),
      );
    },
    mcpDefinition: async (reference) =>
      defined(
        (await find(reference)).definition,
        `${reference.name} has no MCP definition`,
      ),
  };
}

/**
 * The local folder workspace (`~/.barndog/workspace` by default) as a workspace
 * source. Reads the folder directly; nothing is fetched.
 */
export function localRepoSource(
  workspace: LocalWorkspace,
  runtime: RuntimeContext,
): RepoSource {
  return repoSource(
    {
      cacheKey: join("local", workspace.workspaceId),
      workspaceId: workspace.workspaceId,
      label: workspace.path,
      open: () => folderSnapshot(workspace.path, runtime),
      notices: () => [],
      localOnly: true,
    },
    runtime,
  );
}

/** Background refresh policy: check at most every five minutes (milliseconds). */
const AUTO_FETCH_INTERVAL_MS = 300000;

const fetchStateSchema = z.looseObject({
  /** The branch tip this machine last read. */
  accepted: z.string().optional(),
  fetchedAt: z.string().optional(),
});

type FetchState = z.infer<typeof fetchStateSchema>;

/**
 * The commit this machine last accepted from the Git host and when it fetched;
 * empty before the first fetch.
 */
export async function readFetchState(
  workspaceId: string,
  runtime: RuntimeContext,
): Promise<FetchState> {
  const { home } = runtime;

  return (
    (await readJsonIfExists(
      barndogPaths(home).fetchState(workspaceId),
      fetchStateSchema,
    )) ?? {}
  );
}

async function writeFetchState(
  workspaceId: string,
  runtime: RuntimeContext,
  state: FetchState,
) {
  const { home } = runtime;

  await writeAtomic(
    barndogPaths(home).fetchState(workspaceId),
    JSON.stringify(state),
  );
}

/** Creates or repairs the bare clone; nothing is ever checked out of it. */
export async function ensureBareClone(
  repo: string,
  url: string,
  runtime: RuntimeContext,
) {
  await mkdir(repo, { recursive: true, mode: POSIX_MODE.privateDirectory });
  await git(["init", "--quiet", "--bare", "."], runtime, { repo });
  await git(["config", "remote.origin.url", url], runtime, { repo });
}

/**
 * Fetches one branch into the bare clone's tracking ref, without tags.
 * Credential prompts stay off unless `allowPrompt`, so a missing login fails
 * instead of hanging.
 */
export const fetchBranch = (
  repo: string,
  branch: string,
  runtime: RuntimeContext,
  allowPrompt = false,
) =>
  git(
    [
      "fetch",
      "--quiet",
      "--prune",
      "--no-tags",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ],
    runtime,
    { repo, allowPrompt },
  );

/** The ref the bare clone keeps a fetched branch in. */
export function trackingRef(branch: string) {
  return `refs/remotes/origin/${branch}`;
}

const age = (fetchedAt: string | undefined) => {
  if (!fetchedAt) {
    return "an unknown time";
  }

  const minutes = Math.round(
    (Date.now() - Date.parse(fetchedAt)) / MILLISECONDS_PER_MINUTE,
  );

  if (minutes < 1) {
    return "less than a minute";
  }

  if (minutes < MINUTES_PER_HOUR) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  const hours = Math.round(minutes / MINUTES_PER_HOUR);

  return hours < AGE_IN_DAYS_THRESHOLD_HOURS
    ? `${hours} hours`
    : `${Math.round(hours / HOURS_PER_DAY)} days`;
};

/**
 * Reads a Git workspace, fetching by default. Auto refresh reuses a successful
 * fetch for five minutes; none uses only the accepted commit. A failed branch
 * fetch falls back to that commit when available and adds a notice.
 */
export function gitRepoSource(
  workspace: GitWorkspace,
  runtime: RuntimeContext,
  options: SourceOptions = {},
): RepoSource {
  const { home } = runtime;

  const repo = barndogPaths(home).bareClone(workspace.workspaceId);
  const notices: string[] = [];

  async function currentCommit() {
    const state = await readFetchState(workspace.workspaceId, runtime);
    const policy = options.refresh ?? "always";
    const recent =
      state.fetchedAt &&
      Date.now() - Date.parse(state.fetchedAt) < AUTO_FETCH_INTERVAL_MS;

    if (policy === "none" || (policy === "auto" && recent && state.accepted)) {
      if (!state.accepted) {
        throw new CliError(
          "This Git workspace hasn't been fetched yet.",
          "barndog sync",
        );
      }

      return state.accepted;
    }

    await ensureBareClone(repo, workspace.url, runtime);
    try {
      await fetchBranch(repo, workspace.branch, runtime);
    } catch (error) {
      if (!(error instanceof GitError)) {
        throw error;
      }

      if (!state.accepted) {
        throw new CliError(
          `Can't fetch ${workspace.url}: ${gitReason(error.stderr)}. Make sure you can clone it on this machine; BarnDog manages it from there.`,
          `git clone ${workspace.url}`,
          { cause: error },
        );
      }

      notices.push(
        `Can't reach ${workspace.url}, so this uses what was fetched ${age(state.fetchedAt)} ago.`,
      );

      return state.accepted;
    }

    const tip = await gitText(
      ["rev-parse", "--verify", trackingRef(workspace.branch)],
      runtime,
      { repo },
    );

    await writeFetchState(workspace.workspaceId, runtime, {
      accepted: tip,
      fetchedAt: new Date().toISOString(),
    });

    return tip;
  }

  return repoSource(
    {
      cacheKey: join(
        "git",
        createHash("sha256").update(workspace.workspaceId).digest("hex"),
      ),
      workspaceId: workspace.workspaceId,
      label: workspace.url,
      open: async () => gitSnapshot(repo, await currentCommit(), runtime),
      notices: () => notices,
    },
    runtime,
  );
}

/**
 * Records an accepted workspace commit and fetch timestamp after setup or
 * publication. Auto-refresh readers can reuse it without another fetch.
 */
export async function recordFetch(
  workspace: GitWorkspace,
  commit: string,
  runtime: RuntimeContext,
) {
  await writeFetchState(workspace.workspaceId, runtime, {
    accepted: commit,
    fetchedAt: new Date().toISOString(),
  });
}

export const acceptedCommit = async (
  workspaceId: string,
  runtime: RuntimeContext,
) => {
  return (await readFetchState(workspaceId, runtime)).accepted;
};
