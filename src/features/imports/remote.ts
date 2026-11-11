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
} from "../git-workspace/git.js";
import {
  gitSnapshot,
  isBlob,
  type Snapshot,
} from "../git-workspace/snapshot.js";

export type RemoteLocation = {
  url: string;
  /** Everything after /tree/ or /blob/; branch names can contain slashes. */
  rest: string | null;
};

export function parseLocation(input: string): RemoteLocation {
  const value = input.trim();
  const short = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/.exec(value);
  if (short)
    return {
      url: `https://github.com/${short[1]}/${short[2]}.git`,
      rest: null,
    };
  const web =
    /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/(?:-\/)?(tree|blob)\/(.+?)\/?$/.exec(
      value,
    );
  if (web)
    return {
      url: checkRepositoryUrl(`https://${web[1]}/${web[2]}/${web[3]}.git`),
      rest: decodeURIComponent(web[5]!),
    };
  return { url: checkRepositoryUrl(value.replace(/\/$/, "")), rest: null };
}

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
  if (!rest) return { ref: null, path: "" };
  const first = rest.split("/")[0]!;
  if (/^[0-9a-f]{40}$/.test(first))
    return { ref: first, path: rest.slice(first.length + 1) };
  const listing = await gitText(["ls-remote", "--heads", "--tags", "--", url], {
    allowPrompt,
  });
  const refs = listing
    .split("\n")
    .map(
      (line) => line.split("\t")[1]?.replace(/^refs\/(heads|tags)\//, "") ?? "",
    )
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const ref = refs.find((name) => rest === name || rest.startsWith(`${name}/`));
  if (!ref) throw new CliError(`Can't find that branch or tag in ${url}.`);
  return { ref, path: rest.slice(ref.length + 1) };
}

/** Fetches just one commit into a throwaway bare repo; nothing is checked out or run. */
export async function fetchRemote<T>(
  location: RemoteLocation & { ref?: string | null; path?: string },
  options: { allowPrompt: boolean },
  use: (remote: RemoteRepo) => Promise<T>,
): Promise<T> {
  const repo = join(tmpdir(), `barndog-import-${randomUUID()}.git`);
  await mkdir(repo, { recursive: true, mode: 0o700 });
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
    if (error instanceof GitError)
      throw new CliError(
        `Can't read ${location.url}: ${gitReason(error.stderr)}. Make sure you can clone it on this machine.`,
        `git clone ${location.url}`,
        { cause: error },
      );
    throw error;
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}
