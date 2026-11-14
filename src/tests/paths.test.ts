import { expect, test } from "vitest";

import { barndogPaths, localWorkspaceFiles } from "../config/paths.js";

// These paths are public: other CLI versions and the end-to-end tests read the
// files at exactly these places. Changing one is a breaking change.
test("~/.barndog/ keeps every file where earlier versions put it", () => {
  const paths = barndogPaths("/home/dev");

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
    root: "/home/dev/.barndog",
    settings: "/home/dev/.barndog/config.yaml",
    state: "/home/dev/.barndog/state.json",
    pendingSync: "/home/dev/.barndog/pending-sync.json",
    syncLock: "/home/dev/.barndog/sync.lock",
    migrations: "/home/dev/.barndog/migrations",
    cloudCheck: "/home/dev/.barndog/cloud-check.json",
    credentials: "/home/dev/.barndog/credentials.json",
    credentialsLock: "/home/dev/.barndog/credentials.lock",
    nativeAuth: "/home/dev/.barndog/native-auth",
    localWorkspace: "/home/dev/.barndog/workspace",
    git: "/home/dev/.barndog/git",
    bareClone: "/home/dev/.barndog/git/id.git",
    fetchState: "/home/dev/.barndog/git/id.json",
    workingCopies: "/home/dev/.barndog/workspaces",
    workingCopiesLock: "/home/dev/.barndog/workspaces/lock",
    workingCopySnapshots: "/home/dev/.barndog/workspaces/snapshots",
    packageCache: "/home/dev/.barndog/packages/key",
    installedSkills: "/home/dev/.barndog/installed/skills",
    installedHooks: "/home/dev/.barndog/installed/hooks",
  });

  expect(localWorkspaceFiles("/w")).toEqual({
    sources: "/w/.barndog-sources.json",
    moved: "/w/.barndog-moved.json",
  });
});
