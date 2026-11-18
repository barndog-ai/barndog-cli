import { gitAccessCommand } from "../../platform.js";
import type { RuntimeContext } from "../../runtime.js";
import { POSIX_MODE } from "../../shared/constants.js";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { GitWorkspace, LocalWorkspace } from "../../config/settings.js";
import { CliError } from "../../errors.js";
import { CONFIG_FILE, parseConfig, skeleton } from "./format.js";
import {
  git,
  gitInTerminal,
  gitText,
  remoteHead,
  type RemoteHead,
} from "./git.js";
import { commitFiles, pushCommit } from "./publish.js";
import {
  ensureBareClone,
  fetchBranch,
  recordFetch,
  trackingRef,
} from "./repo-source.js";
import { barndogPaths } from "../../config/paths.js";
import { readIfExists } from "../../shared/files.js";
import { errorCode } from "../../shared/values.js";

/**
 * Branch name used when creating the first commit of an empty Git workspace.
 */
const DEFAULT_BRANCH = "main";

/**
 * Queries a remote repository's default head with credential prompts allowed
 * for interactive setup.
 */
export const inspectRepository = (
  url: string,
  runtime: RuntimeContext,
): Promise<RemoteHead> => remoteHead(url, runtime, true);

const stagingClone = (runtime: RuntimeContext) => {
  const { home } = runtime;

  return barndogPaths(home).setupClone(randomUUID());
};

async function adoptClone(
  staging: string,
  workspaceId: string,
  runtime: RuntimeContext,
) {
  const { home } = runtime;

  const target = barndogPaths(home).bareClone(workspaceId);
  await rm(target, { recursive: true, force: true });
  await rename(staging, target);
}

/** Pushes the first commit of a brand-new workspace to an empty repository. */
export async function createGitWorkspace(
  url: string,
  name: string,
  runtime: RuntimeContext,
): Promise<GitWorkspace> {
  const workspaceId = randomUUID();
  const staging = stagingClone(runtime);
  try {
    await ensureBareClone(staging, url, runtime);
    const commit = await commitFiles(
      staging,
      null,
      {
        files: skeleton({ workspaceId, name }).map((file) => ({
          ...file,
          executable: false,
        })),
        message: "Set up BarnDog workspace",
      },
      { allowPrompt: true, runtime },
    );

    await pushCommit(staging, commit, DEFAULT_BRANCH, {
      runtime,
      allowPrompt: true,
    });

    await git(["update-ref", trackingRef(DEFAULT_BRANCH), commit], runtime, {
      repo: staging,
    });

    await adoptClone(staging, workspaceId, runtime);
    const workspace = { url, branch: DEFAULT_BRANCH, workspaceId };
    await recordFetch(workspace, commit, runtime);

    return workspace;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Connects this machine to a repository that already holds a workspace. */
export async function connectGitWorkspace(
  url: string,
  branch: string,
  runtime: RuntimeContext,
): Promise<GitWorkspace> {
  const staging = stagingClone(runtime);
  try {
    await ensureBareClone(staging, url, runtime);
    await fetchBranch(staging, branch, runtime, true);
    const commit = await gitText(["rev-parse", trackingRef(branch)], runtime, {
      repo: staging,
    });

    let text: string;
    try {
      text = await gitText(["show", `${commit}:${CONFIG_FILE}`], runtime, {
        repo: staging,
      });
    } catch (error) {
      throw new CliError(
        `${url} has commits but no ${CONFIG_FILE}, so it isn't a BarnDog workspace. Use an empty repository to start one.`,
        undefined,
        { cause: error },
      );
    }

    const { workspaceId } = parseConfig(text);
    await adoptClone(staging, workspaceId, runtime);
    const workspace = { url, branch, workspaceId };
    await recordFetch(workspace, commit, runtime);

    return workspace;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Clones through the terminal when Git couldn't read the repository quietly, so
 * credential and host-key prompts work. Null means the repository is empty.
 */
export async function cloneGitWorkspace(
  url: string,
  runtime: RuntimeContext,
): Promise<GitWorkspace | null> {
  const staging = stagingClone(runtime);
  await mkdir(dirname(staging), {
    recursive: true,
    mode: POSIX_MODE.privateDirectory,
  });

  try {
    try {
      await gitInTerminal(["clone", "--bare", "--", url, staging], runtime);
    } catch (error) {
      throw new CliError(
        `Git couldn't clone ${url}. Check that you have access, and that this URL is right.`,
        gitAccessCommand(url, runtime.platform),
        { cause: error },
      );
    }

    let commit: string;
    let branch: string;
    try {
      commit = await gitText(["rev-parse", "--verify", "HEAD"], runtime, {
        repo: staging,
      });

      branch = await gitText(["symbolic-ref", "--short", "HEAD"], runtime, {
        repo: staging,
      });
    } catch {
      return null;
    }

    await git(["update-ref", trackingRef(branch), commit], runtime, {
      repo: staging,
    });

    let text: string;
    try {
      text = await gitText(["show", `${commit}:${CONFIG_FILE}`], runtime, {
        repo: staging,
      });
    } catch (error) {
      throw new CliError(
        `${url} has commits but no ${CONFIG_FILE}, so it isn't a BarnDog workspace. Use an empty repository to start one.`,
        undefined,
        { cause: error },
      );
    }

    const { workspaceId } = parseConfig(text);
    await adoptClone(staging, workspaceId, runtime);
    const workspace = { url, branch, workspaceId };
    await recordFetch(workspace, commit, runtime);

    return workspace;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Opens the folder that holds this machine's assets, creating it the first time. */
export async function localWorkspace(
  runtime: RuntimeContext,
  path = barndogPaths(runtime.home).localWorkspace,
): Promise<LocalWorkspace> {
  const config = await readIfExists(join(path, CONFIG_FILE));
  if (config !== null) {
    return { path, workspaceId: parseConfig(config).workspaceId };
  }

  // barndog.yaml goes last, so a run that stopped part way is finished by the
  // next one; files that run already wrote are kept as they are.
  const workspaceId = randomUUID();
  const files = skeleton({ workspaceId, name: "My workspace" }).sort(
    (a, b) => Number(a.path === CONFIG_FILE) - Number(b.path === CONFIG_FILE),
  );

  for (const file of files) {
    const target = join(path, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.data, { flag: "wx" }).catch(
      (error: unknown) => {
        if (errorCode(error) !== "EEXIST" || file.path === CONFIG_FILE) {
          throw error;
        }
      },
    );
  }

  return { path, workspaceId };
}
