import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { GitWorkspace, LocalWorkspace } from "../../config/settings.js";
import { CliError, errorCode } from "../../errors.js";
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
  gitDirectory,
  recordFetch,
  trackingRef,
} from "./source.js";

export const DEFAULT_BRANCH = "main";

export const inspectRepository = (url: string): Promise<RemoteHead> =>
  remoteHead(url, true);

const stagingClone = (home: string) =>
  join(home, ".barndog", "git", `.setup-${randomUUID()}.git`);

async function adoptClone(staging: string, workspaceId: string, home: string) {
  const target = gitDirectory(workspaceId, home);
  await rm(target, { recursive: true, force: true });
  await rename(staging, target);
}

/** Pushes the first commit of a brand-new workspace to an empty repository. */
export async function createGitWorkspace(
  url: string,
  name: string,
  home: string,
): Promise<GitWorkspace> {
  const workspaceId = randomUUID();
  const staging = stagingClone(home);
  try {
    await ensureBareClone(staging, url);
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
      { allowPrompt: true },
    );

    await pushCommit(staging, commit, DEFAULT_BRANCH, true);
    await git(["update-ref", trackingRef(DEFAULT_BRANCH), commit], {
      repo: staging,
    });

    await adoptClone(staging, workspaceId, home);
    const workspace = { url, branch: DEFAULT_BRANCH, workspaceId };
    await recordFetch(workspace, commit, home);

    return workspace;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Connects this machine to a repository that already holds a workspace. */
export async function connectGitWorkspace(
  url: string,
  branch: string,
  home: string,
): Promise<GitWorkspace> {
  const staging = stagingClone(home);
  try {
    await ensureBareClone(staging, url);
    await fetchBranch(staging, branch, true);
    const commit = await gitText(["rev-parse", trackingRef(branch)], {
      repo: staging,
    });

    let text: string;
    try {
      text = await gitText(["show", `${commit}:${CONFIG_FILE}`], {
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
    await adoptClone(staging, workspaceId, home);
    const workspace = { url, branch, workspaceId };
    await recordFetch(workspace, commit, home);

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
  home: string,
): Promise<GitWorkspace | null> {
  const staging = stagingClone(home);
  await mkdir(dirname(staging), { recursive: true, mode: 0o700 });
  try {
    try {
      await gitInTerminal(["clone", "--bare", "--", url, staging]);
    } catch (error) {
      throw new CliError(
        `Git couldn't clone ${url}. Check that you have access, and that this URL is right.`,
        `git clone ${url}`,
        { cause: error },
      );
    }

    let commit: string;
    let branch: string;
    try {
      commit = await gitText(["rev-parse", "--verify", "HEAD"], {
        repo: staging,
      });

      branch = await gitText(["symbolic-ref", "--short", "HEAD"], {
        repo: staging,
      });
    } catch {
      return null;
    }

    await git(["update-ref", trackingRef(branch), commit], { repo: staging });
    let text: string;
    try {
      text = await gitText(["show", `${commit}:${CONFIG_FILE}`], {
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
    await adoptClone(staging, workspaceId, home);
    const workspace = { url, branch, workspaceId };
    await recordFetch(workspace, commit, home);

    return workspace;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export const defaultLocalPath = (home: string) =>
  join(home, ".barndog", "workspace");

/** Opens the folder that holds this machine's assets, creating it the first time. */
export async function localWorkspace(
  home: string,
  path = defaultLocalPath(home),
): Promise<LocalWorkspace> {
  try {
    const { workspaceId } = parseConfig(
      await readFile(join(path, CONFIG_FILE), "utf8"),
    );

    return { path, workspaceId };
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }

  const workspaceId = randomUUID();
  for (const file of skeleton({ workspaceId, name: "My workspace" })) {
    const target = join(path, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.data, { flag: "wx" });
  }

  return { path, workspaceId };
}
