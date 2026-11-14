import { synchronize } from "../environment/sync.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { z } from "zod";
import { changeSchema, type Change } from "@barndog-ai/api-contract";
import type { FileDiff } from "@barndog-ai/api-contract/collaboration";
import { collaborationClient, responseData } from "./domain.js";
import type { PackageKind } from "../../config/selection.js";
import { download, getChange, selectSkill } from "./remote.js";
import { connection } from "../server/connection.js";
import { readSettings, type GitWorkspace } from "../../config/settings.js";
import type { SyncEvent } from "../environment/events.js";
import { CliError } from "../../errors.js";
import { developers } from "../discovery/index.js";
import { LOCAL_ORIGIN } from "../workspace/overlay.js";
import {
  createGitAsset,
  gitVersionDiff,
  gitVersionFiles,
  gitVersions,
  gitWorkingStatus,
  pullGitAsset,
  pushGitWorkingCopy,
  resolveGitConflict,
  updateGitWorkingCopy,
} from "./workspace-git.js";
import {
  NoWorkingCopyError,
  pullSkill,
  createWorkspace,
  workspaceStatus,
  updateWorkspace,
  resolveConflict,
  pushWorkspace,
} from "./workspace.js";

import type {
  ChangeDetails,
  ConflictResolution,
  CreatedPackage,
  PackageVersion,
  PulledPackage,
  PushResult,
  UpdatedWorkingCopy,
  VersionFiles,
  WorkingCopyStatus,
} from "./results.js";
import { allPages } from "../server/pages.js";

/** Who an ID is, when the server will say; IDs still print if it won't. */
const developerNames = (home: string): Promise<Record<string, string>> =>
  developers(undefined, home).then(
    (people) => Object.fromEntries(people.map((p) => [p.id, p.name])),
    () => ({}),
  );

/**
 * A text file's closing newline isn't part of the selected lines. With a known line
 * count it's kept when it really is content: a range that ends on an empty line.
 */
function selectedText(text: string, lines?: number) {
  if (!text.endsWith("\n")) {
    return text;
  }

  return lines === undefined || text.split("\n").length > lines
    ? text.slice(0, -1)
    : text;
}

/**
 * A published Skill or Hook, addressed as commands address it: name and origin
 * selector. `kind` defaults to Skill.
 */
export type PackageTarget = {
  kind?: PackageKind;
  name: string;
  origin: string;
};

/**
 * An asset to pull or create, and the new folder to put it in (`./<name>` by
 * default).
 */
export type WorkingCopyTarget = PackageTarget & { directory?: string };

/**
 * What `push` sends. `name` and `origin` register a folder that isn't a working
 * copy yet; `publish` merges at once where the developer may publish directly.
 */
export type PushOptions = {
  kind?: PackageKind;
  /** Only for a working copy that isn't published yet. */
  name?: string;
  origin?: string;
  publish?: boolean;
  /** Open a new proposal instead of revising the linked one. */
  new?: boolean;
  title?: string;
};

/**
 * A proposal at the revision the caller inspected; reviews and merges are
 * refused once a newer revision exists.
 */
export type ChangeRevision = {
  kind?: PackageKind;
  id: string;
  revision: number;
};

/** A discussion thread on a proposal, at the revision the caller inspected. */
export type ThreadRevision = ChangeRevision & { thread: string };

export type ThreadResolution = ThreadRevision & { resolved: boolean };

/** A published version; the newest when `version` is left out. */
export type VersionTarget = PackageTarget & { version?: number };

export type VersionRange = PackageTarget & { from: number; to: number };

/** Which proposals to list: Skills by default. */
export type ChangeListOptions = { kind?: PackageKind };

export type ChangeTarget = { kind?: PackageKind; id: string };

/** A proposal's diff at a revision (the newest by default), from `fromRevision` or its base. */
export type ChangeDiffTarget = ChangeTarget & {
  revision?: number;
  fromRevision?: number;
};

/**
 * A review's verdict as the CLI spells it; the server's API says
 * `request_changes`.
 */
export type ReviewDecision = "approve" | "request-changes";

/**
 * A comment on a proposal: a new general or inline discussion, or with
 * `thread`, a reply. `body` or `bodyFile` gives the text; `replacementFile` and
 * `expectedFile` turn an inline comment into a suggested replacement of lines
 * `startLine`–`endLine`.
 */
export type CommentOptions = ChangeRevision & {
  body?: string;
  bodyFile?: string;
  /** Reply to this discussion instead of starting one. */
  thread?: string;
  path?: string;
  side?: "old" | "new";
  startLine?: number;
  endLine?: number;
  /** Paths of text files, not the text itself. */
  replacementFile?: string;
  expectedFile?: string;
};

/** Outside a working copy, status and diff describe the machine-wide environment instead. */
export type EnvironmentStatus = { mode: "environment" };

/**
 * `diff` outside a working copy: what the next sync would change on this
 * machine.
 */
export type EnvironmentPreview = {
  mode: "environment-preview";
  events: SyncEvent[];
};

/**
 * Where review happens: pull requests on the Git host, nowhere for a local folder,
 * or the BarnDog API. A Cloud machine can keep a local folder too; only the
 * folder's own assets (`origin` "local") stay out of review.
 */
type Backend =
  | { type: "git"; workspace: GitWorkspace }
  | { type: "local"; path: string }
  | { type: "cloud" };

async function backend(home: string, origin?: string): Promise<Backend> {
  const settings = await readSettings(home);
  if (settings?.gitWorkspace) {
    return { type: "git", workspace: settings.gitWorkspace };
  }

  if (
    settings &&
    settings.localWorkspace &&
    (!settings.connection || origin === LOCAL_ORIGIN)
  ) {
    return { type: "local", path: settings.localWorkspace.path };
  }

  return { type: "cloud" };
}

const noLocalReview = (path: string) =>
  new CliError(
    `Local assets have no review step. Edit them directly in ${path}, then sync.`,
    "barndog sync",
  );

async function cloudConnection(home: string, origin?: string) {
  const where = await backend(home, origin);
  if (where.type === "git") {
    throw new CliError(
      "Reviews happen as pull requests on your Git host in a Git repo workspace.",
      "barndog status",
    );
  }

  if (where.type === "local") {
    throw noLocalReview(where.path);
  }

  return connection(home);
}

/**
 * `create` for a new Skill or Hook: a working copy from the kind's scaffold, in
 * Git or Cloud as the workspace is set up. Local workspaces have no review
 * step, so they are refused with a fix.
 */
export async function createPackage(
  target: WorkingCopyTarget,
  cwd = process.cwd(),
  home = homedir(),
): Promise<CreatedPackage> {
  const where = await backend(home, target.origin);
  if (where.type === "local") {
    throw noLocalReview(where.path);
  }

  if (where.type === "git") {
    return createGitAsset(
      where.workspace,
      { ...target, target: target.directory },
      cwd,
      home,
    );
  }

  return createWorkspace(
    { name: target.name, origin: target.origin, kind: target.kind },
    { target: target.directory, cwd, home },
  );
}

/**
 * `pull <name>`: a new working folder holding the published asset, in Git or
 * Cloud as the workspace is set up. Refused in a local workspace.
 */
export async function pullPackage(
  target: WorkingCopyTarget,
  cwd = process.cwd(),
  home = homedir(),
): Promise<PulledPackage> {
  const where = await backend(home, target.origin);
  if (where.type === "local") {
    throw noLocalReview(where.path);
  }

  if (where.type === "git") {
    return pullGitAsset(
      where.workspace,
      { ...target, target: target.directory },
      cwd,
      home,
    );
  }

  return pullSkill(
    { name: target.name, origin: target.origin, kind: target.kind },
    { target: target.directory, cwd, home },
  );
}

/**
 * `pull` inside a working copy: merges what changed remotely into the folder.
 * Refused in a local workspace.
 */
export async function updateWorkingCopy(
  cwd = process.cwd(),
  home = homedir(),
): Promise<UpdatedWorkingCopy> {
  const where = await backend(home);
  if (where.type === "local") {
    throw noLocalReview(where.path);
  }

  return where.type === "git"
    ? updateGitWorkingCopy(cwd, home)
    : updateWorkspace(cwd, home);
}

/**
 * `status` inside a working copy; anywhere else, or in a local workspace, says
 * to describe the machine-wide environment instead.
 */
export async function workingStatus(
  cwd = process.cwd(),
  home = homedir(),
): Promise<WorkingCopyStatus | EnvironmentStatus> {
  const where = await backend(home);
  if (where.type === "local") {
    return { mode: "environment" };
  }

  try {
    return where.type === "git"
      ? await gitWorkingStatus(cwd, home)
      : await workspaceStatus(cwd, home);
  } catch (error) {
    if (!(error instanceof NoWorkingCopyError)) {
      throw error;
    }

    return { mode: "environment" };
  }
}

/**
 * Returns working-copy edits, or outside a working copy, planned sync events.
 * The dry-run path can still fetch and populate caches.
 */
export async function workingDiff(
  cwd = process.cwd(),
  home = homedir(),
): Promise<FileDiff[] | EnvironmentPreview> {
  const status = await workingStatus(cwd, home);
  if ("changes" in status) {
    return status.changes;
  }

  return {
    mode: "environment-preview",
    events: await synchronize(undefined, home, undefined, { dryRun: true }),
  };
}

/**
 * `push` inside a working copy, to a review branch or proposal as the workspace
 * is set up. Refused in a local workspace.
 */
export async function pushWorkingCopy(
  options: PushOptions,
  cwd = process.cwd(),
  home = homedir(),
): Promise<PushResult> {
  const where = await backend(home, options.origin);
  if (where.type === "local") {
    throw noLocalReview(where.path);
  }

  return where.type === "git"
    ? pushGitWorkingCopy(where.workspace, options, cwd, home)
    : pushWorkspace(options, cwd, home);
}

/**
 * `resolve <path>`: marks one conflicted file resolved once its markers are
 * gone. `path` is relative to `cwd`.
 */
export async function resolveFile(
  path: string,
  cwd = process.cwd(),
  home = homedir(),
): Promise<ConflictResolution> {
  const where = await backend(home);
  if (where.type === "local") {
    throw noLocalReview(where.path);
  }

  return where.type === "git"
    ? resolveGitConflict(path, cwd, home)
    : resolveConflict(path, cwd, home);
}

async function publishedPackage(target: PackageTarget, home: string) {
  const where = await backend(home, target.origin);
  if (where.type === "local") {
    throw noLocalReview(where.path);
  }

  if (where.type === "git") {
    return where;
  }

  const conn = await connection(home);

  return {
    type: "cloud" as const,
    client: collaborationClient(conn.server, home, target.kind),
    skill: await selectSkill(
      { name: target.name, selector: target.origin, kind: target.kind },
      conn,
      home,
    ),
  };
}

/** Newest last. */
export async function packageVersions(
  target: PackageTarget,
  home = homedir(),
): Promise<PackageVersion[]> {
  const where = await publishedPackage(target, home);
  if (where.type === "git") {
    return gitVersions(where.workspace, target, home);
  }

  const [rows, names] = await Promise.all([
    where.client.GET("/v1/skills/{id}/versions", {
      params: { path: { id: where.skill.id } },
    }),
    developerNames(home),
  ]);

  return responseData(rows).map((row) => ({
    ...row,
    publisherName: names[row.publishedBy],
  }));
}

/**
 * A published version's files, base64-encoded; the newest when `version` is
 * left out.
 */
export async function versionFiles(
  target: VersionTarget,
  home = homedir(),
): Promise<VersionFiles> {
  const where = await publishedPackage(target, home);
  if (where.type === "git") {
    return gitVersionFiles(where.workspace, target, home);
  }

  return responseData(
    await where.client.GET("/v1/skills/{id}/content", {
      params: {
        path: { id: where.skill.id },
        query: { version: target.version ?? where.skill.version.number },
      },
    }),
  );
}

export async function diffVersions(
  target: VersionRange,
  home = homedir(),
): Promise<FileDiff[]> {
  const where = await publishedPackage(target, home);
  if (where.type === "git") {
    return gitVersionDiff(where.workspace, target, home);
  }

  return responseData(
    await where.client.GET("/v1/skills/{id}/diff", {
      params: {
        path: { id: where.skill.id },
        query: { from: target.from, to: target.to },
      },
    }),
  );
}

/**
 * Every proposal the developer can see, following the server's pages. Cloud
 * only: a Git workspace reviews in pull requests on its host.
 */
export async function listChanges(
  { kind }: ChangeListOptions = {},
  home = homedir(),
): Promise<Change[]> {
  const client = collaborationClient(
    (await cloudConnection(home)).server,
    home,
    kind,
  );

  return allPages(async (cursor) => {
    const page = responseData(
      await client.GET("/v1/skill-changes", { params: { query: { cursor } } }),
    );

    return {
      items: page.changes.map((c) => changeSchema.parse(c)),
      nextCursor: page.nextCursor,
    };
  });
}

/**
 * A proposal with its files (base64-encoded), its base version number and
 * developer names by ID. Cloud only.
 */
export async function showChange(
  target: ChangeTarget,
  home = homedir(),
): Promise<ChangeDetails> {
  const conn = await cloudConnection(home);
  const id = z.uuid().parse(target.id);
  const client = collaborationClient(conn.server, home, target.kind);
  const change = await getChange(id, conn, home, target.kind);
  const [files, names, versions] = await Promise.all([
    download(
      `/v1/skill-changes/${id}/package?revision=${change.revision}`,
      conn,
      { home, commit: change.commit, kind: target.kind },
    ),
    developerNames(home),
    change.baseVersionId
      ? client
          .GET("/v1/skills/{id}/versions", {
            params: { path: { id: change.skillId } },
          })
          .then(
            (result) => result.data ?? [],
            () => [],
          )
      : [],
  ]);

  return {
    ...change,
    names,
    baseVersionNumber: versions.find((v) => v.id === change.baseVersionId)
      ?.number,
    files: files.map((e) => ({
      path: e.path,
      content: e.data.toString("base64"),
      executable: e.executable,
    })),
  };
}

/**
 * A proposal's diff at a revision (the newest by default), against
 * `fromRevision` or the version it started from. Cloud only.
 */
export async function changeDiff(
  target: ChangeDiffTarget,
  home = homedir(),
): Promise<FileDiff[]> {
  const client = collaborationClient(
    (await cloudConnection(home)).server,
    home,
    target.kind,
  );

  return responseData(
    await client.GET("/v1/skill-changes/{id}/diff", {
      params: {
        path: { id: z.uuid().parse(target.id) },
        query: {
          revision: target.revision,
          fromRevision: target.fromRevision,
        },
      },
    }),
  );
}

async function changeAtRevision(target: ChangeRevision, home: string) {
  return {
    client: collaborationClient(
      (await cloudConnection(home)).server,
      home,
      target.kind,
    ),
    id: z.uuid().parse(target.id),
    body: {
      expectedRevision: z.number().int().positive().parse(target.revision),
    },
  };
}

/**
 * Approves or requests changes on the revision the reviewer inspected. Cloud
 * only.
 */
export async function reviewChange(
  decision: ReviewDecision,
  target: ChangeRevision,
  home = homedir(),
): Promise<Change> {
  const { client, id, body } = await changeAtRevision(target, home);

  return responseData(
    await client.POST("/v1/skill-changes/{id}/reviews", {
      params: { path: { id } },
      body: {
        ...body,
        decision: decision === "approve" ? "approve" : "request_changes",
      },
    }),
  );
}

/**
 * Closes a proposal without publishing it; the author needs `push --new` to
 * propose again. Cloud only.
 */
export async function rejectChange(
  target: ChangeRevision,
  home = homedir(),
): Promise<Change> {
  const { client, id, body } = await changeAtRevision(target, home);

  return responseData(
    await client.POST("/v1/skill-changes/{id}/reject", {
      params: { path: { id } },
      body,
    }),
  );
}

/**
 * Publishes a proposal at the inspected revision, as its scope's review
 * settings allow. Cloud only.
 */
export async function mergeChange(
  target: ChangeRevision,
  home = homedir(),
): Promise<Change> {
  const { client, id, body } = await changeAtRevision(target, home);

  return responseData(
    await client.POST("/v1/skill-changes/{id}/merge", {
      params: { path: { id } },
      body,
    }),
  );
}

/**
 * Adds a comment to a proposal and returns the updated proposal. Reads
 * `bodyFile`, `replacementFile` and `expectedFile` from disk; a file's closing
 * newline isn't part of the selected lines. Cloud only.
 */
export async function commentOnChange(
  options: CommentOptions,
  home = homedir(),
): Promise<Change> {
  const { client, id, body } = await changeAtRevision(options, home);
  const text = options.bodyFile
    ? await readFile(options.bodyFile, "utf8")
    : options.body;

  if (!text?.trim()) {
    throw new CliError(
      "Add the comment with --body <text> or --body-file <path>.",
    );
  }

  if (options.thread) {
    return responseData(
      await client.POST(
        "/v1/skill-changes/{id}/discussions/{threadId}/comments",
        {
          params: { path: { id, threadId: z.uuid().parse(options.thread) } },
          body: { ...body, body: text },
        },
      ),
    );
  }

  return responseData(
    await client.POST("/v1/skill-changes/{id}/discussions", {
      params: { path: { id } },
      body: {
        ...body,
        body: text,
        path: options.path,
        side: options.side,
        startLine: options.startLine,
        endLine: options.endLine,
        replacement: options.replacementFile
          ? selectedText(await readFile(options.replacementFile, "utf8"))
          : undefined,
        expectedContent: options.expectedFile
          ? selectedText(
              await readFile(options.expectedFile, "utf8"),
              options.startLine && options.endLine
                ? options.endLine - options.startLine + 1
                : undefined,
            )
          : undefined,
      },
    }),
  );
}

/** Creates a new revision; the author runs `barndog pull` to receive it. */
export async function applySuggestion(
  target: ThreadRevision,
  home = homedir(),
): Promise<Change> {
  const { client, id, body } = await changeAtRevision(target, home);

  return responseData(
    await client.POST("/v1/skill-changes/{id}/discussions/{threadId}/apply", {
      params: { path: { id, threadId: z.uuid().parse(target.thread) } },
      body,
    }),
  );
}

export async function setDiscussionResolved(
  target: ThreadResolution,
  home = homedir(),
): Promise<Change> {
  const { client, id, body } = await changeAtRevision(target, home);

  return responseData(
    await client.POST("/v1/skill-changes/{id}/discussions/{threadId}/resolve", {
      params: { path: { id, threadId: z.uuid().parse(target.thread) } },
      body: { ...body, resolved: target.resolved },
    }),
  );
}
