import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { normalizeRepositoryRemote } from "@barndog-ai/api-contract";

import { CliError } from "../../errors.js";
import {
  explainIdentity,
  git,
  GitError,
  gitReason,
  gitText,
  parseLsRemote,
} from "./git.js";

const execute = promisify(execFile);

export type NewFile = { path: string; data: Buffer; executable: boolean };

const NULL_HASH = "0".repeat(40);

/** Builds a commit in a bare repository using a throwaway index, never a checkout. */
export async function commitFiles(
  repo: string,
  parent: string | null,
  change: { replace?: string; files: NewFile[] },
  message: string,
  options: { allowPrompt?: boolean } = {},
) {
  const index = join(repo, `barndog-index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    if (parent) await git(["read-tree", parent], { repo, env });
    const updates: string[] = [];
    if (parent && change.replace) {
      const listing = await git(
        ["ls-tree", "-r", "-z", "--name-only", parent, "--", change.replace],
        { repo },
      );
      for (const path of listing.toString("utf8").split("\0").filter(Boolean))
        updates.push(`0 ${NULL_HASH}\t${path}`);
    }
    for (const file of change.files) {
      const hash = await gitText(["hash-object", "-w", "--stdin"], {
        repo,
        input: file.data,
      });
      updates.push(
        `${file.executable ? "100755" : "100644"} ${hash}\t${file.path}`,
      );
    }
    await git(["update-index", "-z", "--index-info"], {
      repo,
      env,
      input: updates.join("\0") + "\0",
    });
    const tree = await gitText(["write-tree"], { repo, env });
    return await gitText(
      ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message],
      { repo, allowPrompt: options.allowPrompt },
    ).catch(explainIdentity);
  } finally {
    await rm(index, { force: true });
    await rm(`${index}.lock`, { force: true });
  }
}

export async function pushCommit(
  repo: string,
  commit: string,
  branch: string,
  allowPrompt = false,
) {
  try {
    await git(["push", "--quiet", "origin", `${commit}:refs/heads/${branch}`], {
      repo,
      allowPrompt,
    });
  } catch (error) {
    if (error instanceof GitError)
      throw new CliError(
        `The Git host rejected the push to ${branch}: ${gitReason(error.stderr)}`,
        undefined,
        { cause: error },
      );
    throw error;
  }
}

/** The tip of a branch on the host, or null when it no longer exists. */
export async function remoteBranch(repo: string, branch: string) {
  const output = await gitText(
    ["ls-remote", "origin", `refs/heads/${branch}`],
    {
      repo,
    },
  );
  return parseLsRemote(output)[0]?.commit ?? null;
}

export function hostOf(url: string) {
  const remote = normalizeRepositoryRemote(url);
  if (!remote) return null;
  const [host, ...path] = remote.split("/");
  if (!host || path.length < 2) return null;
  return { host, path: path.join("/") };
}

/** A browser link that starts a pull request, for hosts with a known URL shape. */
export function compareUrl(url: string, base: string, branch: string) {
  const remote = hostOf(url);
  if (!remote) return null;
  const encoded = branch.split("/").map(encodeURIComponent).join("/");
  if (remote.host.includes("github"))
    return `https://${remote.host}/${remote.path}/compare/${encodeURIComponent(base)}...${encoded}?expand=1`;
  if (remote.host.includes("gitlab"))
    return `https://${remote.host}/${remote.path}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}&merge_request%5Btarget_branch%5D=${encodeURIComponent(base)}`;
  return null;
}

const signedIn = async (tool: string, host: string) => {
  try {
    await execute(tool, ["auth", "status", "--hostname", host], {
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
};

/** The first web link in a tool's output: `Created https://github.com/o/r/pull/1` → the link. */
export const firstUrl = (text: string) => /https?:\/\/\S+/.exec(text)?.[0];

/** Opens the review with gh or glab when signed in, else hands back a link. */
export async function openPullRequest(request: {
  url: string;
  base: string;
  branch: string;
  title: string;
}): Promise<{ url?: string; opened: boolean }> {
  const { url, base, branch, title } = request;
  const remote = hostOf(url);
  const fallback = {
    url: compareUrl(url, base, branch) ?? undefined,
    opened: false,
  };
  if (!remote) return fallback;
  const command = remote.host.includes("github")
    ? [
        "gh",
        "pr",
        "create",
        "--repo",
        `${remote.host}/${remote.path}`,
        "--head",
        branch,
        "--base",
        base,
        "--title",
        title,
        "--body",
        "",
      ]
    : remote.host.includes("gitlab")
      ? [
          "glab",
          "mr",
          "create",
          "-R",
          `${remote.host}/${remote.path}`,
          "-s",
          branch,
          "-b",
          base,
          "-t",
          title,
          "-d",
          "",
          "-y",
        ]
      : null;
  const [program, ...args] = command ?? [];
  if (!program || !(await signedIn(program, remote.host))) return fallback;
  try {
    const { stdout } = await execute(program, args, {
      timeout: 60_000,
    });
    return { url: firstUrl(stdout) ?? fallback.url, opened: true };
  } catch {
    return fallback;
  }
}

/** Reports branch protection where the host will say; null means it can't tell. */
export async function branchProtected(url: string, branch: string) {
  const remote = hostOf(url);
  if (!remote?.host.includes("github") || !(await signedIn("gh", remote.host)))
    return null;
  try {
    const { stdout } = await execute(
      "gh",
      [
        "api",
        "--hostname",
        remote.host,
        `repos/${remote.path}/branches/${encodeURIComponent(branch)}`,
        "--jq",
        ".protected",
      ],
      { timeout: 15_000 },
    );
    return stdout.trim() === "true";
  } catch {
    return null;
  }
}
