import { join } from "node:path";

import { assetFolders, type PackageKind } from "./selection.js";

/**
 * Every path BarnDog keeps under `~/.barndog/`. These files are part of the
 * public surface: older and newer CLI versions, and the end-to-end tests, read
 * them. A new one gets a path here, a Zod schema, one reader, and writes
 * through `writeAtomic()`.
 */
export function barndogPaths(home: string) {
  const root = join(home, ".barndog");
  const git = join(root, "git");
  const workingCopies = join(root, "workspaces");

  return {
    root,
    /** Settings: harnesses, the workspace source and the asset selection. */
    settings: join(root, "config.yaml"),
    /** What BarnDog installed: harness links, native entries, package folders. */
    state: join(root, "state.json"),
    /** The writes of a sync in progress, rolled forward after a crash. */
    pendingSync: join(root, "pending-sync.json"),
    syncLock: join(root, "sync.lock"),
    /** Backups of config.yaml and native files taken before BarnDog changes them. */
    migrations: join(root, "migrations"),
    /** The last Cloud catalog revision a background sync delivered. */
    cloudCheck: join(root, "cloud-check.json"),
    /** Saved sessions, per server. */
    credentials: join(root, "credentials.json"),
    credentialsLock: join(root, "credentials.lock"),
    /** Where `claude mcp login` and `codex mcp login` run. */
    nativeAuth: join(root, "native-auth"),
    /** The default local workspace folder. */
    localWorkspace: join(root, "workspace"),
    /** Bare clones of Git workspaces. */
    git,
    /** The bare clone a Git workspace is read from; nothing is checked out. */
    bareClone: (workspaceId: string) => join(git, `${workspaceId}.git`),
    /** The commit last accepted from a Git workspace's host, and when. */
    fetchState: (workspaceId: string) => join(git, `${workspaceId}.json`),
    /** A clone that `barndog init --repo` checks before keeping it. */
    setupClone: (id: string) => join(git, `.setup-${id}.git`),
    /** Working-copy records, keyed by folder, with their lock and snapshots. */
    workingCopies,
    workingCopiesLock: join(workingCopies, "lock"),
    /** What a working copy held before an update, for recovery. */
    workingCopySnapshots: join(workingCopies, "snapshots"),
    /** The commit-pinned package cache of one source. */
    packageCache: (key: string) => join(root, "packages", key),
    /** Readable folders that harness links point at. */
    installed: (kind: PackageKind) =>
      join(root, "installed", assetFolders[kind]),
  };
}

/** Files BarnDog keeps inside a local workspace folder. */
export function localWorkspaceFiles(folder: string) {
  return {
    /** Assets imported from repositories, and how each one updates. */
    sources: join(folder, ".barndog-sources.json"),
    /** Assets moved to a shared workspace, so sync stops installing the local copy. */
    moved: join(folder, ".barndog-moved.json"),
  };
}

/** Beside each cached package: the fingerprint it was stored with. */
export const packageManifest = (revisionFolder: string) =>
  join(revisionFolder, "manifest.json");
