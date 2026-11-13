import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { GitWorkspace, LocalWorkspace } from "../../config/settings.js";
import { CliError } from "../../errors.js";
import { errorCode } from "../../shared/values.js";
import type { AssetReference } from "../asset-selection/types.js";
import { storePackage } from "../environment/packages.js";
import type { WorkspaceSource } from "../environment/source.js";
import type { SourceOptions } from "../environment/workspace-source.js";
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
import { writeAtomic } from "../../shared/files.js";

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
  home: string,
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
      throw new Error("Catalog changed during staging; retry sync");
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
    skillOrHookPackage: async (kind, reference) => {
      const asset = await find(reference);

      return storePackage(
        kind,
        {
          id: asset.id,
          name: asset.name,
          revision: asset.publishedVersion,
        },
        { key: backend.cacheKey, home },
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

export function localRepoSource(
  workspace: LocalWorkspace,
  home: string,
): RepoSource {
  return repoSource(
    {
      cacheKey: join("local", workspace.workspaceId),
      workspaceId: workspace.workspaceId,
      label: workspace.path,
      open: () => folderSnapshot(workspace.path),
      notices: () => [],
      localOnly: true,
    },
    home,
  );
}

const AUTO_FETCH_INTERVAL_MS = 5 * 60 * 1000;

const fetchStateSchema = z.looseObject({
  /** The branch tip this machine last read. */
  accepted: z.string().optional(),
  fetchedAt: z.string().optional(),
});

type FetchState = z.infer<typeof fetchStateSchema>;

export const gitDirectory = (workspaceId: string, home: string) =>
  join(home, ".barndog", "git", `${workspaceId}.git`);

const statePath = (workspaceId: string, home: string) =>
  join(home, ".barndog", "git", `${workspaceId}.json`);

export async function readFetchState(
  workspaceId: string,
  home: string,
): Promise<FetchState> {
  try {
    return fetchStateSchema.parse(
      JSON.parse(await readFile(statePath(workspaceId, home), "utf8")),
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return {};
    }

    throw error;
  }
}

async function writeFetchState(
  workspaceId: string,
  home: string,
  state: FetchState,
) {
  await writeAtomic(statePath(workspaceId, home), JSON.stringify(state));
}

/** Creates or repairs the bare clone; nothing is ever checked out of it. */
export async function ensureBareClone(repo: string, url: string) {
  await mkdir(repo, { recursive: true, mode: 0o700 });
  await git(["init", "--quiet", "--bare", "."], { repo });
  await git(["config", "remote.origin.url", url], { repo });
}

export const fetchBranch = (
  repo: string,
  branch: string,
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
    { repo, allowPrompt },
  );

export function trackingRef(branch: string) {
  return `refs/remotes/origin/${branch}`;
}

const age = (fetchedAt: string | undefined) => {
  if (!fetchedAt) {
    return "an unknown time";
  }

  const minutes = Math.round((Date.now() - Date.parse(fetchedAt)) / 60000);
  if (minutes < 1) {
    return "less than a minute";
  }

  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  const hours = Math.round(minutes / 60);

  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
};

export function gitRepoSource(
  workspace: GitWorkspace,
  home: string,
  options: SourceOptions = {},
): RepoSource {
  const repo = gitDirectory(workspace.workspaceId, home);
  const notices: string[] = [];

  async function currentCommit() {
    const state = await readFetchState(workspace.workspaceId, home);
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

    await ensureBareClone(repo, workspace.url);
    try {
      await fetchBranch(repo, workspace.branch);
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
      { repo },
    );

    await writeFetchState(workspace.workspaceId, home, {
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
      open: async () => gitSnapshot(repo, await currentCommit()),
      notices: () => notices,
    },
    home,
  );
}

export async function recordFetch(
  workspace: GitWorkspace,
  commit: string,
  home: string,
) {
  await writeFetchState(workspace.workspaceId, home, {
    accepted: commit,
    fetchedAt: new Date().toISOString(),
  });
}

export const acceptedCommit = async (workspaceId: string, home: string) =>
  (await readFetchState(workspaceId, home)).accepted;
