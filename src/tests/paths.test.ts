import { resolve } from "node:path";
import { expect, test } from "vitest";

import { barndogPaths, localWorkspaceFiles } from "../config/paths.js";

// These paths are public: other CLI versions and the end-to-end tests read the
// files at exactly these places. Changing one is a breaking change.
test("~/.barndog/ keeps every file where earlier versions put it", () => {
  const paths = barndogPaths(resolve("/home/dev"));

  expect({
    root: paths.root,
    settings: paths.settings,
    state: paths.state,
    pendingSync: paths.pendingSync,
    syncLock: paths.syncLock,
    migrations: paths.migrations,
    cloudCheck: paths.cloudCheck,
    credentials: paths.credentials,
    credentialsLock: paths.credentialsLock,
    nativeAuth: paths.nativeAuth,
    localWorkspace: paths.localWorkspace,
    git: paths.git,
    bareClone: paths.bareClone("id"),
    fetchState: paths.fetchState("id"),
    workingCopies: paths.workingCopies,
    workingCopiesLock: paths.workingCopiesLock,
    workingCopySnapshots: paths.workingCopySnapshots,
    packageCache: paths.packageCache("key"),
    installedSkills: paths.installed("skill"),
    installedHooks: paths.installed("hook"),
  }).toEqual({
    root: resolve("/home/dev/.barndog"),
    settings: resolve("/home/dev/.barndog/config.yaml"),
    state: resolve("/home/dev/.barndog/state.json"),
    pendingSync: resolve("/home/dev/.barndog/pending-sync.json"),
    syncLock: resolve("/home/dev/.barndog/sync.lock"),
    migrations: resolve("/home/dev/.barndog/migrations"),
    cloudCheck: resolve("/home/dev/.barndog/cloud-check.json"),
    credentials: resolve("/home/dev/.barndog/credentials.json"),
    credentialsLock: resolve("/home/dev/.barndog/credentials.lock"),
    nativeAuth: resolve("/home/dev/.barndog/native-auth"),
    localWorkspace: resolve("/home/dev/.barndog/workspace"),
    git: resolve("/home/dev/.barndog/git"),
    bareClone: resolve("/home/dev/.barndog/git/id.git"),
    fetchState: resolve("/home/dev/.barndog/git/id.json"),
    workingCopies: resolve("/home/dev/.barndog/workspaces"),
    workingCopiesLock: resolve("/home/dev/.barndog/workspaces/lock"),
    workingCopySnapshots: resolve("/home/dev/.barndog/workspaces/snapshots"),
    packageCache: resolve("/home/dev/.barndog/packages/key"),
    installedSkills: resolve("/home/dev/.barndog/installed/skills"),
    installedHooks: resolve("/home/dev/.barndog/installed/hooks"),
  });

  expect(localWorkspaceFiles(resolve("/w"))).toEqual({
    sources: resolve("/w/.barndog-sources.json"),
    moved: resolve("/w/.barndog-moved.json"),
  });
});
