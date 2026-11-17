import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assert, expect, test } from "vitest";
import { git } from "../features/workspace/git.js";
import { connectGitWorkspace } from "../features/workspace/setup.js";
import {
  pullGitAsset,
  selectScope,
  createGitAsset,
  resolveGitConflict,
  pushGitWorkingCopy,
  updateGitWorkingCopy,
  gitVersionFiles,
} from "../features/collaboration/workspace-git.js";
import { loadWorkspace } from "../features/workspace/format.js";
import { folderSnapshot } from "../features/workspace/snapshot.js";
import { fetchRemote } from "../features/imports/remote.js";
import { gitRepoSource } from "../features/workspace/repo-source.js";
import { findGit } from "../features/collaboration/workspace-store.js";
import { saveSettings, SetupRequiredError } from "../config/settings.js";
import { CliError } from "../shared/cli-error.js";
import {
  saveImported,
  updateImported,
  importedFrom,
  ensureLocalWorkspace,
  followImports,
} from "../features/imports/local.js";
import { barndogPaths } from "../config/paths.js";
import { writeAtomic } from "../shared/files.js";
import { testRuntime } from "./runtime.js";

async function fixture(t: {
  onTestFinished: (fn: () => Promise<void>) => void;
}) {
  const home = await mkdtemp(join(tmpdir(), "barndog-git-errors-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const repo = join(home, "upstream");
  await mkdir(repo);
  const runtime = testRuntime(home, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
  });

  await git(["init", "--quiet", "--initial-branch=main"], runtime, { repo });
  await writeFile(
    join(repo, "barndog.yaml"),
    `version: 1\nworkspaceId: ${randomUUID()}\nname: Fixture\n`,
  );

  await mkdir(join(repo, "org/skills/review"), { recursive: true });
  await writeFile(
    join(repo, "org/skills/review/SKILL.md"),
    "---\nname: review\ndescription: Reviews code\n---\nOriginal\n",
  );

  await git(["add", "."], runtime, { repo });
  await git(["commit", "--quiet", "-m", "Initial"], runtime, { repo });
  const workspace = await connectGitWorkspace(repo, "main", runtime);
  const copy = join(home, "copy");
  await pullGitAsset(
    workspace,
    { name: "review", origin: "org", kind: "skill", target: copy },
    runtime,
  );

  return { home, repo, runtime: { ...runtime, cwd: copy }, workspace, copy };
}

/** Runs an operation that must fail with a CliError and returns it. */
async function refusal(operation: Promise<unknown>): Promise<CliError> {
  const error = await operation.then(
    () => undefined,
    (e: unknown) => e,
  );

  assert(
    error instanceof CliError,
    `expected a CliError, got ${String(error)}`,
  );

  return error;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const branches = async ({ repo, runtime }: Fixture) =>
  (await git(["branch", "--format=%(refname:short)"], runtime, { repo }))
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .sort();

const revision = async ({ repo, runtime }: Fixture, ref: string) =>
  (await git(["rev-parse", ref], runtime, { repo })).toString("utf8").trim();

const commitUpstream = async (
  { repo, runtime }: Fixture,
  message: string,
  change: () => Promise<void>,
) => {
  await change();
  await git(["add", "."], runtime, { repo });
  await git(["commit", "--quiet", "-m", message], runtime, { repo });
};

const edit = async (path: string, change: (text: string) => string) =>
  writeFile(path, change(await readFile(path, "utf8")));

/** Pushes a local edit as a review proposal and returns its branch. */
async function propose(f: Fixture, text = "\nLocal edit\n") {
  await edit(join(f.copy, "SKILL.md"), (body) => body + text);
  const result = await pushGitWorkingCopy(f.workspace, {}, f.runtime);
  assert("branch" in result, "Expected a review branch");

  return result.branch;
}

test("pushing with the wrong kind is refused with a pointer to status, and no branch is created", async (t) => {
  const f = await fixture(t);
  const error = await refusal(
    pushGitWorkingCopy(f.workspace, { kind: "hook" }, f.runtime),
  );

  expect(error.message).toBe("This working copy holds a skill, not a hook.");
  expect(error.hint).toBe("barndog status");
  expect(await branches(f)).toEqual(["main"]);
});

test("pushing with the wrong name is refused with a pointer to status", async (t) => {
  const f = await fixture(t);
  const error = await refusal(
    pushGitWorkingCopy(f.workspace, { name: "other" }, f.runtime),
  );

  expect(error.message).toBe("This working copy is review, not other.");
  expect(error.hint).toBe("barndog status");
});

test("a working copy from another Git workspace cannot push here", async (t) => {
  const f = await fixture(t);
  await expect(
    pushGitWorkingCopy(
      { ...f.workspace, workspaceId: randomUUID() },
      {},
      f.runtime,
    ),
  ).rejects.toThrow("names a different workspace");

  expect(await branches(f)).toEqual(["main"]);
});

test("renaming the asset in its manifest blocks the push and keeps the edit", async (t) => {
  const f = await fixture(t);
  const path = join(f.copy, "SKILL.md");
  await edit(path, (body) => body.replace("name: review", "name: other"));
  const changed = await readFile(path, "utf8");

  const error = await refusal(pushGitWorkingCopy(f.workspace, {}, f.runtime));

  expect(error.message).toBe(
    "This working copy's name must stay review. Change it back, then push again.",
  );

  expect(error.hint).toBeUndefined();
  expect(await readFile(path, "utf8")).toBe(changed);
  expect(await branches(f)).toEqual(["main"]);
});

test("asking for a version that does not exist names the asset and version", async (t) => {
  const f = await fixture(t);
  const error = await refusal(
    gitVersionFiles(
      f.workspace,
      { kind: "skill", name: "review", origin: "org", version: 99 },
      f.runtime,
    ),
  );

  expect(error.message).toBe("review has no version 99.");
});

test("pulling an asset that is not in the workspace names the kind, asset and scope", async (t) => {
  const f = await fixture(t);
  const error = await refusal(
    pullGitAsset(
      f.workspace,
      { kind: "skill", name: "absent", origin: "org" },
      f.runtime,
    ),
  );

  expect(error.message).toContain("No Skill named absent in org");
});

test("pushing unchanged content with --publish makes no commit on main", async (t) => {
  const f = await fixture(t);
  const main = await revision(f, "main");

  expect(
    await pushGitWorkingCopy(f.workspace, { publish: true }, f.runtime),
  ).toEqual({ unchanged: true });

  expect(await revision(f, "main")).toBe(main);
  expect(await branches(f)).toEqual(["main"]);
});

test("a review branch deleted on the host is recreated by the next push, without touching main", async (t) => {
  const f = await fixture(t);
  const main = await revision(f, "main");
  const first = await propose(f);
  expect(await branches(f)).toContain(first);

  await git(["branch", "-D", first], f.runtime, { repo: f.repo });
  expect(await branches(f)).toEqual(["main"]);

  const second = await pushGitWorkingCopy(f.workspace, {}, f.runtime);
  assert("branch" in second, "Expected a review branch");

  expect(await branches(f)).toContain(second.branch);
  expect(await revision(f, second.branch)).not.toBe(main);
  expect(await revision(f, "main")).toBe(main);
  expect(await updateGitWorkingCopy(f.runtime)).toMatchObject({
    conflicts: [],
  });
});

test("Git scope selection accepts new team and repo folders", async (t) => {
  const { repo, runtime } = await fixture(t);
  const model = await loadWorkspace(await folderSnapshot(repo, runtime));

  expect(selectScope(model, "team/new")).toMatchObject({
    type: "team",
    path: "teams/new",
  });

  expect(selectScope(model, "repo/new")).toMatchObject({
    type: "repo",
    path: "repos/new",
  });
});

for (const [selector, message] of [
  ["me", "Personal scopes don't exist in a Git repo workspace"],
  ["dev/alice", "Personal scopes don't exist in a Git repo workspace"],
  ["team", "No scope named team. Use org, team/<slug> or repo/<slug>."],
  ["missing", "No scope named missing. Use org, team/<slug> or repo/<slug>."],
] as const) {
  test(`Git scope selection rejects ${selector}`, async (t) => {
    const { repo, runtime } = await fixture(t);
    const model = await loadWorkspace(await folderSnapshot(repo, runtime));

    expect(() => selectScope(model, selector)).toThrow(message);
    expect(() => selectScope(model, selector)).toThrow(CliError);
  });
}

test("creating a Git asset with an invalid name is refused before anything is written", async (t) => {
  const f = await fixture(t);
  const error = await refusal(
    createGitAsset(
      f.workspace,
      { kind: "skill", name: "Bad Name", origin: "org" },
      f.runtime,
    ),
  );

  expect(error.message).toContain("Bad Name isn't a valid name");
  expect(await branches(f)).toEqual(["main"]);
});

test("a review branch that moved on the host blocks pushing until pulled, and pulling merges its edit", async (t) => {
  const f = await fixture(t);
  const path = join(f.copy, "SKILL.md");
  const branch = await propose(f);
  await git(["checkout", "--quiet", branch], f.runtime, { repo: f.repo });
  await commitUpstream(f, "Remote review edit", () =>
    edit(
      join(f.repo, "org/skills/review/SKILL.md"),
      (body) => body + "\nRemote review edit\n",
    ),
  );

  await git(["checkout", "--quiet", "main"], f.runtime, { repo: f.repo });
  const error = await refusal(pushGitWorkingCopy(f.workspace, {}, f.runtime));

  expect(error.message).toBe(`${branch} changed on the Git host.`);
  expect(error.hint).toBe("barndog pull");

  expect(await updateGitWorkingCopy(f.runtime)).toMatchObject({
    conflicts: [],
  });

  const merged = await readFile(path, "utf8");
  expect(merged).toContain("Remote review edit");
  expect(merged).toContain("Local edit");
});

test("publishing is refused when main moved since the asset was pulled", async (t) => {
  const f = await fixture(t);
  const path = join(f.copy, "SKILL.md");
  await edit(path, (body) => body + "\nLocal edit\n");
  await commitUpstream(f, "Main changed", () =>
    edit(join(f.repo, "org/skills/review/SKILL.md"), (body) =>
      body.replace("Original", "Main content"),
    ),
  );

  const main = await revision(f, "main");
  const error = await refusal(
    pushGitWorkingCopy(f.workspace, { publish: true }, f.runtime),
  );

  expect(error.message).toBe("review changed on main since you pulled it.");
  expect(error.hint).toBe("barndog pull");
  expect(await revision(f, "main")).toBe(main);
  expect(await readFile(path, "utf8")).toContain("Local edit");
});

test("conflicting edits block push and pull until resolved, then pushing works", async (t) => {
  const f = await fixture(t);
  const path = join(f.copy, "SKILL.md");
  await commitUpstream(f, "Main changed", () =>
    edit(join(f.repo, "org/skills/review/SKILL.md"), (body) =>
      body.replace("Original", "Main content"),
    ),
  );

  await edit(path, (body) => body.replace("Original", "Local content"));

  const updated = await updateGitWorkingCopy(f.runtime);
  expect(updated.conflicts).toEqual(["SKILL.md"]);
  expect(await readFile(path, "utf8")).toContain("<<<<<<<");

  const push = await refusal(pushGitWorkingCopy(f.workspace, {}, f.runtime));
  expect(push.message).toBe("Resolve the conflicts before pushing.");
  expect(push.hint).toBe("barndog resolve <path>");

  const pull = await refusal(updateGitWorkingCopy(f.runtime));
  expect(pull.message).toBe(
    "Resolve the existing conflicts before pulling again.",
  );

  expect(pull.hint).toBe("barndog resolve <path>");
  expect(await branches(f)).toEqual(["main"]);

  await writeFile(
    path,
    "---\nname: review\ndescription: Review\n---\nResolved\n",
  );

  expect(await resolveGitConflict("SKILL.md", f.runtime)).toMatchObject({
    resolved: "SKILL.md",
  });

  const pushed = await pushGitWorkingCopy(f.workspace, {}, f.runtime);
  assert("branch" in pushed, "Expected a review branch after resolving");
  expect(
    (
      await git(
        ["show", `${pushed.branch}:org/skills/review/SKILL.md`],
        f.runtime,
        {
          repo: f.repo,
        },
      )
    ).toString("utf8"),
  ).toContain("Resolved");
});

test("review reconciliation refuses a remote branch that removed the asset", async (t) => {
  const f = await fixture(t);
  const branch = await propose(f, "\nEdit\n");
  await git(["checkout", "--quiet", branch], f.runtime, { repo: f.repo });
  await commitUpstream(f, "Remove asset", () =>
    rm(join(f.repo, "org/skills/review"), { recursive: true }),
  );

  await git(["checkout", "--quiet", "main"], f.runtime, { repo: f.repo });
  const error = await refusal(updateGitWorkingCopy(f.runtime));

  expect(error.message).toBe(`${branch} no longer contains review.`);
});

test("repository imports pick the longest matching branch or tag, then a commit, and split off the folder", async (t) => {
  const f = await fixture(t);
  const { repo, runtime } = f;
  const main = await revision(f, "main");
  await git(["tag", "feature"], runtime, { repo });
  await git(["checkout", "--quiet", "-b", "feature/x"], runtime, { repo });
  await git(
    ["commit", "--quiet", "--allow-empty", "-m", "On branch"],
    runtime,
    {
      repo,
    },
  );

  const branch = await revision(f, "feature/x");
  await git(["checkout", "--quiet", "main"], runtime, { repo });
  expect(branch).not.toBe(main);

  const table = [
    { rest: "feature/x/org", ref: "feature/x", path: "org", commit: branch },
    { rest: `${main}/org`, ref: main, path: "org", commit: main },
    { rest: "feature", ref: "feature", path: "", commit: main },
  ];

  for (const { rest, ref, path, commit } of table) {
    await fetchRemote(
      { url: repo, rest },
      { allowPrompt: false },
      async (remote) => {
        expect({
          ref: remote.ref,
          path: remote.path,
          commit: remote.commit,
        }).toEqual({
          ref,
          path,
          commit,
        });
      },
      runtime,
    );
  }
});

test("a repository import naming no branch, tag or commit is refused", async (t) => {
  const { repo, runtime } = await fixture(t);
  const error = await refusal(
    fetchRemote(
      { url: repo, rest: "missing/path" },
      { allowPrompt: false },
      async () => undefined,
      runtime,
    ),
  );

  expect(error.message).toBe(`Can't find that branch or tag in ${repo}.`);
});

test("a cached snapshot refuses a package whose catalog entry changed", async (t) => {
  const { runtime, workspace } = await fixture(t);
  const cached = gitRepoSource(workspace, runtime, { refresh: "none" });
  const asset = (await cached.model()).assets[0]!;

  await expect(
    cached.packageFolder("skill", {
      ...asset,
      id: "22222222-2222-4222-8222-222222222222",
    }),
  ).rejects.toThrow("catalog changed");

  await expect(
    cached.packageFolder("skill", { ...asset, publishedVersion: "different" }),
  ).rejects.toThrow("catalog changed");
});

/** How long ago the last fetch was, and the age the unreachable-host notice shows. */
const fetchAges = [
  { minutes: undefined, text: "an unknown time" },
  { minutes: 0, text: "less than a minute" },
  { minutes: 1, text: "1 minute" },
  { minutes: 2, text: "2 minutes" },
  { minutes: 30, text: "30 minutes" },
  { minutes: 59, text: "59 minutes" },
  { minutes: 60, text: "1 hour" },
  { minutes: 120, text: "2 hours" },
  { minutes: 47 * 60, text: "47 hours" },
  { minutes: 48 * 60, text: "2 days" },
  { minutes: 4320, text: "3 days" },
];

for (const { minutes, text } of fetchAges) {
  test(`an unreachable host falls back to the last fetch and says it was ${text} ago (${minutes ?? "no timestamp"})`, async (t) => {
    const { repo, runtime, workspace } = await fixture(t);
    const work = await findGit(runtime);
    const path = barndogPaths(runtime.home).fetchState(workspace.workspaceId);
    await rm(repo, { recursive: true });
    await writeAtomic(
      path,
      JSON.stringify({
        accepted: work.baseCommit,
        ...(minutes === undefined
          ? {}
          : {
              fetchedAt: new Date(Date.now() - minutes * 60000).toISOString(),
            }),
      }),
    );

    const source = gitRepoSource(workspace, runtime);

    expect((await source.model()).assets).toHaveLength(1);
    expect(source.notices()).toEqual([
      `Can't reach ${workspace.url}, so this uses what was fetched ${text} ago.`,
    ]);
  });
}

test("a workspace that was never fetched cannot be read from cache or from an unreachable host", async (t) => {
  const { repo, runtime, workspace } = await fixture(t);
  await rm(repo, { recursive: true });
  await writeAtomic(
    barndogPaths(runtime.home).fetchState(workspace.workspaceId),
    "{}",
  );

  const cached = await refusal(
    gitRepoSource(workspace, runtime, { refresh: "none" }).model(),
  );

  expect(cached.message).toBe("This Git workspace hasn't been fetched yet.");
  expect(cached.hint).toBe("barndog sync");

  const fetched = await refusal(gitRepoSource(workspace, runtime).model());
  expect(fetched.message).toContain(`Can't fetch ${workspace.url}`);
  expect(fetched.hint).toBe(`git clone ${workspace.url}`);
});

/** A local workspace holding `review`, added from the fixture's upstream repo. */
async function trackedImport(f: Fixture, mode: "auto" | "manual" = "auto") {
  const { repo, runtime } = f;
  await saveSettings({ harnesses: [] }, runtime.home);
  const local = await ensureLocalWorkspace(runtime);
  const target = join(local.path, "org/skills/review");
  await mkdir(target, { recursive: true });
  const entries = [
    {
      path: "SKILL.md",
      data: await readFile(join(repo, "org/skills/review/SKILL.md")),
      executable: false,
    },
  ];

  await fetchRemote(
    { url: repo, rest: null },
    { allowPrompt: false },
    async (remote) => {
      await saveImported(
        {
          kind: "skill",
          name: "review",
          mode,
          root: "org/skills/review",
          entries,
          remote,
        },
        runtime,
      );
    },
    runtime,
  );

  return { local, path: join(target, "SKILL.md") };
}

const upstreamEdit = (f: Fixture, from: string, to: string) =>
  commitUpstream(f, `Upstream ${to}`, () =>
    edit(join(f.repo, "org/skills/review/SKILL.md"), (body) =>
      body.replace(from, to),
    ),
  );

test("import tracking needs setup and an existing import before it can update", async (t) => {
  const { runtime } = await fixture(t);
  expect(await importedFrom("skill", "review", runtime)).toBeNull();
  await expect(ensureLocalWorkspace(runtime)).rejects.toThrow(
    SetupRequiredError,
  );

  const none = await refusal(updateImported("skill", undefined, {}, runtime));
  expect(none.message).toBe("This machine has no assets added from a repo.");
});

test("tracked imports are recorded per kind and name", async (t) => {
  const f = await fixture(t);
  await trackedImport(f);

  expect(await importedFrom("skill", "review", f.runtime)).toMatchObject({
    mode: "auto",
  });

  expect(await importedFrom("hook", "review", f.runtime)).toBeNull();

  const error = await refusal(
    updateImported("skill", "missing", {}, f.runtime),
  );

  expect(error.message).toBe(
    "missing wasn't added from a repo, so it has nothing to update from.",
  );
});

test("updating refuses to overwrite local edits unless forced, and --force restores upstream content", async (t) => {
  const f = await fixture(t);
  const { path } = await trackedImport(f);
  await edit(path, (body) => body + "\nPrivate edit\n");
  await upstreamEdit(f, "Original", "Upstream v2");

  const error = await refusal(updateImported("skill", "review", {}, f.runtime));

  expect(error.message).toBe(
    "review was edited locally, so updating would lose those edits.",
  );

  expect(error.hint).toBe("barndog skills update review --force");
  expect(await readFile(path, "utf8")).toContain("Private edit");

  await updateImported("skill", "review", { force: true }, f.runtime);
  const body = await readFile(path, "utf8");
  expect(body).toContain("Upstream v2");
  expect(body).not.toContain("Private edit");
});

test("following imports reports a locally edited asset instead of overwriting it", async (t) => {
  const f = await fixture(t);
  const { local, path } = await trackedImport(f);
  await edit(path, (body) => body + "\nPrivate edit\n");
  await upstreamEdit(f, "Original", "Upstream v2");

  expect(await followImports(local.path, "always", f.runtime)).toEqual([
    "review wasn't updated from its repo: review was edited locally, so updating would lose those edits.",
  ]);

  expect(await readFile(path, "utf8")).toContain("Private edit");
  expect(await readFile(path, "utf8")).not.toContain("Upstream v2");
});

test("following imports honors the policy: none never fetches, auto waits five minutes, always always fetches", async (t) => {
  const f = await fixture(t);
  const { local, path } = await trackedImport(f);
  await upstreamEdit(f, "Original", "Upstream v2");

  expect(await followImports(local.path, "none", f.runtime)).toEqual([]);
  expect(await readFile(path, "utf8")).toContain("Original");

  expect(await followImports(local.path, "auto", f.runtime)).toEqual([]);
  expect(await readFile(path, "utf8")).toContain("Upstream v2");

  await upstreamEdit(f, "Upstream v2", "Upstream v3");
  expect(await followImports(local.path, "auto", f.runtime)).toEqual([]);
  expect(await readFile(path, "utf8")).toContain("Upstream v2");
  expect(await readFile(path, "utf8")).not.toContain("Upstream v3");

  expect(await followImports(local.path, "always", f.runtime)).toEqual([]);
  expect(await readFile(path, "utf8")).toContain("Upstream v3");
});

test("imports that are not followed automatically are left alone by following", async (t) => {
  const f = await fixture(t);
  const { local, path } = await trackedImport(f, "manual");
  await upstreamEdit(f, "Original", "Upstream v2");

  expect(await followImports(local.path, "always", f.runtime)).toEqual([]);
  expect(await readFile(path, "utf8")).toContain("Original");
});

test("updating an import whose upstream folder was removed says it no longer exists", async (t) => {
  const f = await fixture(t);
  await trackedImport(f);
  await commitUpstream(f, "Remove upstream", () =>
    rm(join(f.repo, "org/skills/review"), { recursive: true }),
  );

  const error = await refusal(updateImported("skill", "review", {}, f.runtime));

  expect(error.message).toBe(
    `org/skills/review no longer exists in ${f.repo}.`,
  );
});
