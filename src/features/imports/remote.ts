import { POSIX_MODE } from "../../shared/constants.js";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliError } from "../../errors.js";
import {
  checkRepositoryUrl,
  git,
  GitError,
  gitReason,
  gitText,
  parseLsRemote,
} from "../git-workspace/git.js";
import { GIT_OBJECT_ID } from "../../shared/patterns.js";
import {
  gitSnapshot,
  isBlob,
  type Snapshot,
} from "../git-workspace/snapshot.js";

/**
 * Parsed repository URL and unresolved tree/blob suffix; branch names may
 * themselves contain slashes.
 */
export type RemoteLocation = {
  url: string;
  /** Everything after /tree/ or /blob/; branch names can contain slashes. */
  rest: string | null;
};

/** GitHub shorthand, `<owner>/<repo>`: `anthropics/skills`. */
const GITHUB_SHORTHAND = /^([\da-z][\da-z-]*)\/([\w.-]+)$/i;

/**
 * A link to a folder or file in a repository's web view, on GitHub
 * (`https://github.com/o/r/tree/main/skills/x`) or GitLab
 * (`https://gitlab.com/o/r/-/blob/v1/hook.yaml`). Groups: host, owner, repo,
 * then everything after `tree/` or `blob/`.
 */
const WEB_TREE_URL =
  /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/(?:-\/)?(?:tree|blob)\/(.+?)\/?$/;

/** Reads what someone pasted: a GitHub shorthand, a web link into a repository, or a clone URL. */
export function parseLocation(input: string): RemoteLocation {
  const value = input.trim();
  const short = GITHUB_SHORTHAND.exec(value);
  if (short) {
    return {
      url: `https://github.com/${short[1]}/${short[2]}.git`,
      rest: null,
    };
  }

  const [, host, owner, repo, rest] = WEB_TREE_URL.exec(value) ?? [];
  if (rest !== undefined) {
    return {
      url: checkRepositoryUrl(`https://${host}/${owner}/${repo}.git`),
      rest: decodeURIComponent(rest),
    };
  }

  return { url: checkRepositoryUrl(value.replace(/\/$/, "")), rest: null };
}

/**
 * Resolved upstream commit, selected path and snapshot bytes used to discover
 * and import repository content.
 */
export type RemoteRepo = {
  url: string;
  ref: string | null;
  commit: string;
  /** Folder or file the link pointed at, or "" for the whole repo. */
  path: string;
  snapshot: Snapshot;
  blobs: Map<string, Buffer>;
};

/** Splits `<ref>/<path>` against the refs that really exist on the remote. */
async function resolveRest(
  url: string,
  rest: string | null,
  allowPrompt: boolean,
) {
  if (!rest) {
    return { ref: null, path: "" };
  }

  const [first = ""] = rest.split("/");
  if (GIT_OBJECT_ID.test(first)) {
    return { ref: first, path: rest.slice(first.length + 1) };
  }

  const listing = await gitText(["ls-remote", "--heads", "--tags", "--", url], {
    allowPrompt,
  });

  const refs = parseLsRemote(listing)
    .map(({ ref }) => ref.replace(/^refs\/(?:heads|tags)\//, ""))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  const ref = refs.find((name) => rest === name || rest.startsWith(`${name}/`));
  if (!ref) {
    throw new CliError(`Can't find that branch or tag in ${url}.`);
  }

  return { ref, path: rest.slice(ref.length + 1) };
}

/** Fetches just one commit into a throwaway bare repo; nothing is checked out or run. */
export async function fetchRemote<T>(
  location: RemoteLocation & { ref?: string | null; path?: string },
  options: { allowPrompt: boolean },
  use: (remote: RemoteRepo) => Promise<T>,
): Promise<T> {
  const repo = join(tmpdir(), `barndog-import-${randomUUID()}.git`);
  await mkdir(repo, { recursive: true, mode: POSIX_MODE.privateDirectory });
  try {
    await git(["init", "--quiet", "--bare", "."], { repo });
    const resolved =
      location.ref !== undefined
        ? { ref: location.ref, path: location.path ?? "" }
        : await resolveRest(location.url, location.rest, options.allowPrompt);

    await git(
      [
        "fetch",
        "--quiet",
        "--depth",
        "1",
        "--no-tags",
        "--",
        location.url,
        resolved.ref ?? "HEAD",
      ],
      { repo, allowPrompt: options.allowPrompt },
    );

    const commit = await gitText(["rev-parse", "FETCH_HEAD"], { repo });
    const snapshot = await gitSnapshot(repo, commit);
    const blobs = await snapshot.readBlobs(
      snapshot.entries
        .filter((entry) => isBlob(entry.mode))
        .map((entry) => entry.hash),
    );

    return await use({
      url: location.url,
      ref: resolved.ref,
      commit,
      path: resolved.path.replace(/\/$/, ""),
      snapshot,
      blobs,
    });
  } catch (error) {
    if (error instanceof GitError) {
      throw new CliError(
        `Can't read ${location.url}: ${gitReason(error.stderr)}. Make sure you can clone it on this machine.`,
        `git clone ${location.url}`,
        { cause: error },
      );
    }

    throw error;
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}
