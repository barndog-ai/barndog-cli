import { MILLISECONDS_PER_SECOND } from "../../shared/constants.js";

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { mkdir, realpath, rm } from "node:fs/promises";

import {
  packageFingerprint,
  validatePackageEntries,
  writePackage,
  type PackageEntry,
} from "@barndog-ai/api-contract/package";
import {
  diffEntries,
  mergeEntries,
  readDirectory,
  type FileDiff,
} from "@barndog-ai/api-contract/collaboration";

import type { GitWorkspace } from "../../config/settings.js";
import { type AssetKind, type PackageKind } from "../../config/selection.js";
import { CliError } from "../../errors.js";
import {
  assetPath,
  loadWorkspace,
  type RepoAsset,
  type RepoScope,
  type WorkspaceModel,
} from "../git-workspace/format.js";
import { git, gitText } from "../git-workspace/git.js";
import {
  commitFiles,
  openPullRequest,
  pushCommit,
  remoteBranch,
} from "../git-workspace/publish.js";
import { isBlob, gitSnapshot, GIT_MODE } from "../git-workspace/snapshot.js";
import {
  acceptedCommit,
  gitDirectory,
  gitRepoSource,
  recordFetch,
  trackingRef,
} from "../git-workspace/source.js";
import {
  metadata as packageMetadataFor,
  assetKinds,
  assetNotFound,
} from "../asset-kinds/index.js";
import { matchesOrigin } from "../server/origin.js";
import { markResolved } from "./workspace.js";
import {
  applyFiles,
  decodeFiles,
  encodeFiles,
  findGit,
  locked,
  save,
  type GitWorkingCopy,
} from "./workspace-store.js";
import { defined, only } from "../../shared/lookup.js";
import { NAME, splitOrigin } from "../../shared/patterns.js";

import type {
  ConflictResolution,
  CreatedPackage,
  GitPushResult,
  GitWorkingCopyStatus,
  PackageVersion,
  PulledPackage,
  UpdatedGitWorkingCopy,
  VersionFiles,
} from "./results.js";

/** Three random bytes provide six hex characters to distinguish work branches. */
const BRANCH_RANDOM_BYTES = 3;

async function latest(workspace: GitWorkspace, home: string) {
  const model = await gitRepoSource(workspace, home).model();

  return {
    model,
    commit: defined(
      await acceptedCommit(workspace.workspaceId, home),
      "This Git workspace hasn't been fetched yet",
    ),
  };
}

function selectAsset(
  model: WorkspaceModel,
  kind: AssetKind,
  name: string,
  origin: string,
) {
  const matches = model.assets.filter(
    (asset) =>
      asset.kind === kind &&
      asset.name === name &&
      matchesOrigin(asset.origin, origin, model),
  );

  const match = only(matches);
  if (!match) {
    throw assetNotFound(kind, name, origin);
  }

  return match;
}

/**
 * The repository scope an origin selector names, for a new asset. A team or
 * repo that has no folder yet is still accepted, so the first asset can create
 * it; personal scopes don't exist in a Git workspace and are refused.
 */
export function selectScope(model: WorkspaceModel, origin: string) {
  const matches = model.scopes.filter((scope) =>
    matchesOrigin(scope, origin, model),
  );

  const { type, value: slug } = splitOrigin(origin);
  if (origin === "me" || (type === "dev" && slug !== undefined)) {
    throw new CliError(
      "Personal scopes don't exist in a Git repo workspace. Use org, team/<slug> or repo/<slug>.",
    );
  }

  if (!matches.length && (type === "team" || type === "repo") && slug) {
    return {
      type,
      slug,
      path: `${type === "team" ? "teams" : "repos"}/${slug}`,
    } as const;
  }

  const match = only(matches);
  if (!match) {
    throw new CliError(
      `No scope named ${origin}. Use org, team/<slug> or repo/<slug>.`,
    );
  }

  return pickScope(match);
}

const pickScope = (scope: RepoScope) => ({
  type: scope.type,
  slug: scope.slug,
  path: scope.path,
});

const usable = (asset: RepoAsset) => {
  if (asset.invalid) {
    throw new CliError(
      `${asset.path} is invalid: ${asset.invalid}. Fix it on the Git host first.`,
    );
  }

  return asset;
};

async function newFolder(cwd: string, target: string) {
  const path = resolve(cwd, target);
  await mkdir(dirname(path), { recursive: true });
  // Never overwrite an existing directory, even if it appears empty.
  await mkdir(path);

  return realpath(path);
}

async function startWorkingCopy(
  root: string,
  record: Omit<GitWorkingCopy, "root" | "base" | "conflicts">,
  { entries, base }: { entries: PackageEntry[]; base: PackageEntry[] },
  home: string,
) {
  try {
    await writePackage(root, entries);
    await save(
      { ...record, root, base: encodeFiles(base), conflicts: [] },
      home,
    );
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Creates and registers a working folder from the current Git workspace
 * snapshot. Takes the working-copy lock and attempts a fetch, with cached
 * content used if fetching fails. Rejects existing folders and invalid assets.
 */
export function pullGitAsset(
  workspace: GitWorkspace,
  options: {
    name: string;
    origin: string;
    target?: string;
    kind?: PackageKind;
  },
  cwd: string,
  home = homedir(),
): Promise<PulledPackage> {
  const kind = options.kind ?? "skill";

  return locked(home, async () => {
    const { model, commit } = await latest(workspace, home);
    const asset = usable(
      selectAsset(model, kind, options.name, options.origin),
    );

    const root = await newFolder(cwd, options.target ?? options.name);
    await startWorkingCopy(
      root,
      {
        kind,
        git: workspace,
        name: asset.name,
        scope: pickScope(asset.origin),
        baseCommit: commit,
      },
      { entries: asset.entries, base: asset.entries },
      home,
    );

    return { root, commit };
  });
}

/**
 * Starts a working copy from the kind's scaffold, fetching workspace metadata
 * first. Asset content is not pushed until `push`.
 */
export function createGitAsset(
  workspace: GitWorkspace,
  options: {
    name: string;
    origin: string;
    target?: string;
    kind?: PackageKind;
  },
  cwd: string,
  home = homedir(),
): Promise<CreatedPackage> {
  const kind = options.kind ?? "skill";

  return locked(home, async () => {
    if (!NAME.test(options.name)) {
      throw new CliError(
        `${options.name} isn't a valid name. Use lowercase letters, digits and hyphens, such as my-skill.`,
      );
    }

    const { model, commit } = await latest(workspace, home);
    const scope = selectScope(model, options.origin);
    const root = await newFolder(cwd, options.target ?? options.name);
    await startWorkingCopy(
      root,
      { kind, git: workspace, name: options.name, scope, baseCommit: commit },
      { entries: assetKinds[kind].scaffold(options.name), base: [] },
      home,
    );

    return { root, kind, name: options.name };
  });
}

/**
 * The working copy containing `cwd`, with its edits as diffs against the commit
 * it started from. Throws `CliError` outside a working copy.
 */
export function gitWorkingStatus(
  cwd: string,
  home = homedir(),
): Promise<GitWorkingCopyStatus> {
  return locked(home, async () => {
    const work = await findGit(cwd, home);

    return {
      root: work.root,
      name: work.name,
      baseVersion: null,
      baseCommit: work.baseCommit,
      proposal: null,
      review: work.review
        ? { branch: work.review.branch, url: work.review.url ?? null }
        : null,
      conflicts: work.conflicts,
      pending: false,
      external: null,
      changes: await diffEntries(
        decodeFiles(work.base),
        await readDirectory(work.root),
      ),
    };
  });
}

const assetIn = (model: WorkspaceModel, work: GitWorkingCopy) =>
  model.assets.find(
    (asset) =>
      asset.kind === work.kind &&
      asset.path === assetPath(work.scope.path, work.kind, work.name),
  );

const fingerprint = (entries: PackageEntry[]) => packageFingerprint(entries);

async function branchFiles(work: GitWorkingCopy, head: string, home: string) {
  const { branch } = defined(
    work.review,
    "This working copy has no review branch",
  );

  const repo = gitDirectory(work.git.workspaceId, home);
  await git(
    ["fetch", "--quiet", "--no-tags", "origin", `refs/heads/${branch}`],
    { repo },
  );

  const model = await loadWorkspace(await gitSnapshot(repo, head));
  const asset = assetIn(model, work);
  if (!asset) {
    throw new CliError(`${branch} no longer contains ${work.name}.`);
  }

  return usable(asset).entries;
}

/**
 * `pull` for a Git working copy: merges edits pushed to its review branch, then
 * the newest default-branch content, into the folder. Conflicting text gets
 * base/local/remote markers and is listed in `conflicts`; refuses to run while
 * earlier conflicts are unresolved. Drops the review once the default branch
 * holds its content.
 */
export function updateGitWorkingCopy(
  cwd: string,
  home = homedir(),
): Promise<UpdatedGitWorkingCopy> {
  return locked(home, async () => {
    const work = await findGit(cwd, home);
    const previous = structuredClone(work);
    if (work.conflicts.length) {
      throw new CliError(
        "Resolve the existing conflicts before pulling again.",
        "barndog resolve <path>",
      );
    }

    const repo = gitDirectory(work.git.workspaceId, home);
    const { model, commit } = await latest(work.git, home);
    let entries = await readDirectory(work.root);
    const conflicts = new Set<string>();
    const merge = async (base: PackageEntry[], incoming: PackageEntry[]) => {
      const merged = await mergeEntries(base, entries, incoming);
      entries = merged.entries;
      merged.conflicts.forEach((path) => conflicts.add(path));
    };

    if (work.review) {
      const head = await remoteBranch(repo, work.review.branch);
      if (head && head !== work.review.head) {
        const remote = await branchFiles(work, head, home);
        await merge(decodeFiles(work.review.files), remote);
        work.review = {
          ...work.review,
          head,
          files: encodeFiles(remote),
        };
      }
    }

    const current = assetIn(model, work);
    if (current) {
      const incoming = usable(current).entries;
      if (fingerprint(incoming) !== fingerprint(decodeFiles(work.base))) {
        await merge(decodeFiles(work.base), incoming);
      }

      work.base = encodeFiles(incoming);
      // The review is over once its content is what the default branch holds.
      if (
        work.review &&
        fingerprint(incoming) === fingerprint(decodeFiles(work.review.files))
      ) {
        delete work.review;
      }
    }

    work.baseCommit = commit;
    work.conflicts = [...conflicts];
    await applyFiles(work, entries, home, previous);

    return {
      root: work.root,
      conflicts: work.conflicts,
      baseVersion: null,
      commit,
    };
  });
}

/**
 * Marks one conflicted file resolved, after checking its conflict markers are
 * gone.
 */
export function resolveGitConflict(
  path: string,
  cwd: string,
  home = homedir(),
): Promise<ConflictResolution> {
  return locked(home, async () =>
    markResolved(await findGit(cwd, home), path, cwd, home),
  );
}

/**
 * `push` for a Git working copy. With `publish`, commits straight to the
 * workspace's default branch; otherwise commits to a review branch
 * (`barndog/<scope>-<name>-<random>`) and opens a pull request when the host
 * allows one. Inside a folder that isn't a working copy yet, `origin` registers
 * it first. Refused when the review branch moved on the host since the last
 * pull, or, with `publish`, when the asset changed on the default branch.
 */
export function pushGitWorkingCopy(
  workspace: GitWorkspace,
  options: {
    origin?: string;
    kind?: PackageKind;
    name?: string;
    publish?: boolean;
    new?: boolean;
    title?: string;
  },
  cwd: string,
  home = homedir(),
): Promise<GitPushResult> {
  return locked(home, async () => {
    const { model, commit: tip } = await latest(workspace, home);
    let work: GitWorkingCopy;
    try {
      work = await findGit(cwd, home);
    } catch (error) {
      if (!options.origin || !(error instanceof CliError)) {
        throw error;
      }

      const root = await realpath(cwd);
      const kind = options.kind ?? "skill";
      work = {
        root,
        kind,
        git: workspace,
        name: packageMetadataFor(await readDirectory(root), kind).name,
        scope: selectScope(model, options.origin),
        baseCommit: tip,
        base: [],
        conflicts: [],
      };

      await save(work, home);
    }

    if (options.kind && work.kind !== options.kind) {
      throw new CliError(
        `This working copy holds a ${work.kind}, not a ${options.kind}.`,
        "barndog status",
      );
    }

    if (options.name && work.name !== options.name) {
      throw new CliError(
        `This working copy is ${work.name}, not ${options.name}.`,
        "barndog status",
      );
    }

    if (work.git.workspaceId !== workspace.workspaceId) {
      throw new CliError(
        "This working copy belongs to a different Git workspace.",
      );
    }

    if (work.conflicts.length) {
      throw new CliError(
        "Resolve the conflicts before pushing.",
        "barndog resolve <path>",
      );
    }

    const files = validatePackageEntries(
      await readDirectory(work.root),
      undefined,
      assetKinds[work.kind].manifest,
    );

    if (packageMetadataFor(files, work.kind).name !== work.name) {
      throw new CliError(
        `This working copy's name must stay ${work.name}. Change it back, then push again.`,
      );
    }

    const repo = gitDirectory(workspace.workspaceId, home);
    const path = assetPath(work.scope.path, work.kind, work.name);
    const change = {
      replace: path,
      files: files.map((file) => ({
        ...file,
        path: `${path}/${file.path}`,
      })),
    };

    const title = options.title ?? `Update ${work.name}`;

    if (options.publish) {
      const current = assetIn(model, work);
      if (
        fingerprint(current?.entries ?? []) !==
        fingerprint(decodeFiles(work.base))
      ) {
        throw new CliError(
          `${work.name} changed on ${workspace.branch} since you pulled it.`,
          "barndog pull",
        );
      }

      if (fingerprint(files) === fingerprint(decodeFiles(work.base))) {
        return { unchanged: true };
      }

      const commit = await commitFiles(repo, tip, {
        ...change,
        message: title,
      });

      await pushCommit(repo, commit, workspace.branch);
      await git(["update-ref", trackingRef(workspace.branch), commit], {
        repo,
      });

      await recordFetch(workspace, commit, home);
      work.base = encodeFiles(files);
      work.baseCommit = commit;
      delete work.review;
      await save(work, home);

      return { branch: workspace.branch, commit, published: true };
    }

    let review = options.new ? undefined : work.review;
    if (review) {
      const head = await remoteBranch(repo, review.branch);
      if (head === null) {
        review = undefined;
      } else if (head !== review.head) {
        throw new CliError(
          `${review.branch} changed on the Git host.`,
          "barndog pull",
        );
      }
    }

    const previous = review
      ? decodeFiles(review.files)
      : decodeFiles(work.base);

    if (fingerprint(files) === fingerprint(previous)) {
      return { unchanged: true };
    }

    const branch =
      review?.branch ??
      `barndog/${work.scope.type === "org" ? "org" : `${work.scope.type}-${work.scope.slug}`}-${work.name}-${randomBytes(BRANCH_RANDOM_BYTES).toString("hex")}`;

    const commit = await commitFiles(repo, review?.head ?? work.baseCommit, {
      ...change,
      message: title,
    });

    await pushCommit(repo, commit, branch);
    const opened = review?.url
      ? { url: review.url, opened: false }
      : await openPullRequest({
          url: workspace.url,
          base: workspace.branch,
          branch,
          title,
        });

    work.review = {
      branch,
      head: commit,
      files: encodeFiles(files),
      ...(opened.url ? { url: opened.url } : {}),
    };

    await save(work, home);

    return { branch, commit, url: opened.url ?? null, opened: opened.opened };
  });
}

/** Commits that changed an asset, oldest first; their position is the version number. */
async function assetHistory(repo: string, commit: string, path: string) {
  const output = await gitText(
    ["log", "--reverse", "--format=%H%x00%ct%x00%an%x00%s", commit, "--", path],
    { repo },
  );

  return output
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      const [hash, time, author, subject] = line.split("\0");
      if (!hash || author === undefined || subject === undefined) {
        throw new Error(`Unexpected git log line: ${line}`);
      }

      return {
        number: index + 1,
        commit: hash,
        publishedAt: new Date(
          Number(time) * MILLISECONDS_PER_SECOND,
        ).toISOString(),
        publishedBy: author,
        description: subject,
      };
    });
}

async function filesAt(repo: string, commit: string, path: string) {
  const snapshot = await gitSnapshot(repo, commit);
  const single = snapshot.entries.find((entry) => entry.path === path);
  const members =
    single && single.mode !== GIT_MODE.tree
      ? [{ ...single, path: path.slice(path.lastIndexOf("/") + 1) }]
      : snapshot.entries
          .filter(
            (entry) => entry.path.startsWith(`${path}/`) && isBlob(entry.mode),
          )
          .map((entry) => ({
            ...entry,
            path: entry.path.slice(path.length + 1),
          }));

  const blobs = await snapshot.readBlobs(members.map((entry) => entry.hash));

  return members.map((entry): PackageEntry => ({
    path: entry.path,
    data: defined(
      blobs.get(entry.hash),
      `Git object ${entry.hash} wasn't read`,
    ),
    executable: entry.mode === GIT_MODE.executable,
  }));
}

type HistoryTarget = { name: string; origin: string; kind?: AssetKind };

/** An asset's published history: one version per commit that changed it. */
async function history(
  workspace: GitWorkspace,
  target: HistoryTarget,
  home: string,
) {
  const { model, commit } = await latest(workspace, home);
  const asset = selectAsset(
    model,
    target.kind ?? "skill",
    target.name,
    target.origin,
  );

  const repo = gitDirectory(workspace.workspaceId, home);
  const versions = await assetHistory(repo, commit, asset.path);
  const filesOf = (number = versions.length) => {
    const version = versions[number - 1];
    if (!version) {
      throw new CliError(`${asset.name} has no version ${number}.`);
    }

    return filesAt(repo, version.commit, asset.path);
  };

  return { versions, filesOf };
}

/**
 * Every commit that changed the asset's folder, oldest first and numbered from
 * 1, as Git workspaces have no published version numbers of their own.
 */
export async function gitVersions(
  workspace: GitWorkspace,
  target: HistoryTarget,
  home = homedir(),
): Promise<PackageVersion[]> {
  return (await history(workspace, target, home)).versions;
}

/** A version's files, base64-encoded; the newest when `version` is left out. */
export async function gitVersionFiles(
  workspace: GitWorkspace,
  target: HistoryTarget & { version?: number },
  home = homedir(),
): Promise<VersionFiles> {
  const { filesOf } = await history(workspace, target, home);

  return { files: encodeFiles(await filesOf(target.version)) };
}

/**
 * What changed in the asset between two versions, numbered as `gitVersions()`
 * numbers them.
 */
export async function gitVersionDiff(
  workspace: GitWorkspace,
  target: HistoryTarget & { from: number; to: number },
  home = homedir(),
): Promise<FileDiff[]> {
  const { filesOf } = await history(workspace, target, home);

  return diffEntries(await filesOf(target.from), await filesOf(target.to));
}
