import { synchronize } from "../environment/sync.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { z } from "zod";
import { changeSchema, type Change } from "@barndog-ai/api-contract";
import { collaborationClient, type PackageKind } from "./domain.js";
import { connection, download, getChange, selectSkill } from "./remote.js";
import { readSettings, type GitWorkspace } from "../../config/settings.js";
import type { SyncEvent } from "../skills/sync.js";
import { CliError } from "../../errors.js";
import { developers } from "../discovery/index.js";
import { LOCAL_ORIGIN } from "../git-workspace/overlay.js";
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
export function selectedText(text: string, lines?: number) {
  if (!text.endsWith("\n")) return text;
  return lines === undefined || text.split("\n").length > lines
    ? text.slice(0, -1)
    : text;
}

export type PackageTarget = {
  kind?: PackageKind;
  name: string;
  origin: string;
};

export type WorkingCopyTarget = PackageTarget & { directory?: string };

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

export type ChangeRevision = {
  kind?: PackageKind;
  id: string;
  revision: number;
};

export type ThreadRevision = ChangeRevision & { thread: string };

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
  if (settings?.version === 2 && settings.gitWorkspace)
    return { type: "git", workspace: settings.gitWorkspace };
  if (
    settings?.version === 2 &&
    settings.localWorkspace &&
    (!settings.connection || origin === LOCAL_ORIGIN)
  )
    return { type: "local", path: settings.localWorkspace.path };
  return { type: "cloud" };
}

const noLocalReview = (path: string) =>
  new CliError(
    `Local assets have no review step. Edit them directly in ${path}, then sync.`,
    "barndog sync",
  );

async function cloudConnection(home: string, origin?: string) {
  const where = await backend(home, origin);
  if (where.type === "git")
    throw new CliError(
      "Reviews happen as pull requests on your Git host in a Git repo workspace.",
      "barndog status",
    );
  if (where.type === "local") throw noLocalReview(where.path);
  return connection(home);
}

export async function createPackage(
  target: WorkingCopyTarget,
  cwd = process.cwd(),
  home = homedir(),
) {
  const where = await backend(home, target.origin);
  if (where.type === "local") throw noLocalReview(where.path);
  if (where.type === "git")
    return createGitAsset(
      where.workspace,
      { ...target, target: target.directory },
      cwd,
      home,
    );
  return createWorkspace(
    target.name,
    target.origin,
    target.directory,
    cwd,
    home,
    target.kind,
  );
}

export async function pullPackage(
  target: WorkingCopyTarget,
  cwd = process.cwd(),
  home = homedir(),
) {
  const where = await backend(home, target.origin);
  if (where.type === "local") throw noLocalReview(where.path);
  if (where.type === "git")
    return pullGitAsset(
      where.workspace,
      { ...target, target: target.directory },
      cwd,
      home,
    );
  return pullSkill(
    target.name,
    target.origin,
    target.directory,
    cwd,
    home,
    target.kind,
  );
}

export async function updateWorkingCopy(cwd = process.cwd(), home = homedir()) {
  const where = await backend(home);
  if (where.type === "local") throw noLocalReview(where.path);
  return where.type === "git"
    ? updateGitWorkingCopy(cwd, home)
    : updateWorkspace(cwd, home);
}

export async function workingStatus(
  cwd = process.cwd(),
  home = homedir(),
): Promise<
  | Awaited<ReturnType<typeof gitWorkingStatus>>
  | Awaited<ReturnType<typeof workspaceStatus>>
  | EnvironmentStatus
> {
  const where = await backend(home);
  if (where.type === "local") return { mode: "environment" };
  try {
    return where.type === "git"
      ? await gitWorkingStatus(cwd, home)
      : await workspaceStatus(cwd, home);
  } catch (error) {
    if (!(error instanceof NoWorkingCopyError)) throw error;
    return { mode: "environment" };
  }
}

export async function workingDiff(
  cwd = process.cwd(),
  home = homedir(),
): Promise<
  | Awaited<ReturnType<typeof gitWorkingStatus>>["changes"]
  | Awaited<ReturnType<typeof workspaceStatus>>["changes"]
  | EnvironmentPreview
> {
  const status = await workingStatus(cwd, home);
  if ("changes" in status) return status.changes;
  return {
    mode: "environment-preview",
    events: await synchronize(undefined, home, undefined, { dryRun: true }),
  };
}

export async function pushWorkingCopy(
  options: PushOptions,
  cwd = process.cwd(),
  home = homedir(),
) {
  const where = await backend(home, options.origin);
  if (where.type === "local") throw noLocalReview(where.path);
  return where.type === "git"
    ? pushGitWorkingCopy(where.workspace, options, cwd, home)
    : pushWorkspace(options, cwd, home);
}

export async function resolveFile(
  path: string,
  cwd = process.cwd(),
  home = homedir(),
) {
  const where = await backend(home);
  if (where.type === "local") throw noLocalReview(where.path);
  return where.type === "git"
    ? resolveGitConflict(path, cwd, home)
    : resolveConflict(path, cwd, home);
}

async function publishedPackage(target: PackageTarget, home: string) {
  const where = await backend(home, target.origin);
  if (where.type === "local") throw noLocalReview(where.path);
  if (where.type === "git") return where;
  const conn = await connection(home);
  return {
    type: "cloud" as const,
    client: collaborationClient(conn.server, home, target.kind),
    skill: await selectSkill(
      target.name,
      target.origin,
      conn,
      home,
      target.kind,
    ),
  };
}

/** Newest last. */
export async function packageVersions(target: PackageTarget, home = homedir()) {
  const where = await publishedPackage(target, home);
  if (where.type === "git") return gitVersions(where.workspace, target, home);
  const [rows, names] = await Promise.all([
    where.client.GET("/v1/skills/{id}/versions", {
      params: { path: { id: where.skill.id } },
    }),
    developerNames(home),
  ]);
  return rows.data!.map((row) => ({
    ...row,
    publisherName: names[row.publishedBy],
  }));
}

export async function versionFiles(
  target: PackageTarget & { version?: number },
  home = homedir(),
) {
  const where = await publishedPackage(target, home);
  if (where.type === "git")
    return gitVersionFiles(where.workspace, target, home);
  return (
    await where.client.GET("/v1/skills/{id}/content", {
      params: {
        path: { id: where.skill.id },
        query: { version: target.version ?? where.skill.version.number },
      },
    })
  ).data!;
}

export async function diffVersions(
  target: PackageTarget & { from: number; to: number },
  home = homedir(),
) {
  const where = await publishedPackage(target, home);
  if (where.type === "git")
    return gitVersionDiff(where.workspace, target, home);
  return (
    await where.client.GET("/v1/skills/{id}/diff", {
      params: {
        path: { id: where.skill.id },
        query: { from: target.from, to: target.to },
      },
    })
  ).data!;
}

export async function listChanges(
  { kind }: { kind?: PackageKind } = {},
  home = homedir(),
) {
  const client = collaborationClient(
    (await cloudConnection(home)).server,
    home,
    kind,
  );
  const result: Change[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = (
      await client.GET("/v1/skill-changes", { params: { query: { cursor } } })
    ).data!;
    result.push(...page.changes.map((c) => changeSchema.parse(c)));
    if (page.nextCursor && seen.has(page.nextCursor))
      throw new Error("Invalid pagination");
    if (page.nextCursor) seen.add(page.nextCursor);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return result;
}

export async function showChange(
  target: { kind?: PackageKind; id: string },
  home = homedir(),
) {
  const conn = await cloudConnection(home);
  const id = z.uuid().parse(target.id);
  const client = collaborationClient(conn.server, home, target.kind);
  const change = await getChange(id, conn, home, target.kind);
  const [files, names, versions] = await Promise.all([
    download(
      `/v1/skill-changes/${id}/package?revision=${change.revision}`,
      conn,
      home,
      change.commit,
      target.kind,
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

export async function changeDiff(
  target: {
    kind?: PackageKind;
    id: string;
    revision?: number;
    fromRevision?: number;
  },
  home = homedir(),
) {
  const client = collaborationClient(
    (await cloudConnection(home)).server,
    home,
    target.kind,
  );
  return (
    await client.GET("/v1/skill-changes/{id}/diff", {
      params: {
        path: { id: z.uuid().parse(target.id) },
        query: {
          revision: target.revision,
          fromRevision: target.fromRevision,
        },
      },
    })
  ).data!;
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

export async function reviewChange(
  decision: "approve" | "request-changes",
  target: ChangeRevision,
  home = homedir(),
) {
  const { client, id, body } = await changeAtRevision(target, home);
  return (
    await client.POST("/v1/skill-changes/{id}/reviews", {
      params: { path: { id } },
      body: {
        ...body,
        decision: decision === "approve" ? "approve" : "request_changes",
      },
    })
  ).data!;
}

export async function rejectChange(target: ChangeRevision, home = homedir()) {
  const { client, id, body } = await changeAtRevision(target, home);
  return (
    await client.POST("/v1/skill-changes/{id}/reject", {
      params: { path: { id } },
      body,
    })
  ).data!;
}

export async function mergeChange(target: ChangeRevision, home = homedir()) {
  const { client, id, body } = await changeAtRevision(target, home);
  return (
    await client.POST("/v1/skill-changes/{id}/merge", {
      params: { path: { id } },
      body,
    })
  ).data!;
}

export async function commentOnChange(
  options: CommentOptions,
  home = homedir(),
) {
  const { client, id, body } = await changeAtRevision(options, home);
  const text = options.bodyFile
    ? await readFile(options.bodyFile, "utf8")
    : options.body;
  if (!text?.trim())
    throw new Error("Supply --body <text> or --body-file <path>");
  if (options.thread)
    return (
      await client.POST(
        "/v1/skill-changes/{id}/discussions/{threadId}/comments",
        {
          params: { path: { id, threadId: z.uuid().parse(options.thread) } },
          body: { ...body, body: text },
        },
      )
    ).data!;
  return (
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
    })
  ).data!;
}

/** Creates a new revision; the author runs `barndog pull` to receive it. */
export async function applySuggestion(
  target: ThreadRevision,
  home = homedir(),
) {
  const { client, id, body } = await changeAtRevision(target, home);
  return (
    await client.POST("/v1/skill-changes/{id}/discussions/{threadId}/apply", {
      params: { path: { id, threadId: z.uuid().parse(target.thread) } },
      body,
    })
  ).data!;
}

export async function setDiscussionResolved(
  target: ThreadRevision & { resolved: boolean },
  home = homedir(),
) {
  const { client, id, body } = await changeAtRevision(target, home);
  return (
    await client.POST("/v1/skill-changes/{id}/discussions/{threadId}/resolve", {
      params: { path: { id, threadId: z.uuid().parse(target.thread) } },
      body: { ...body, resolved: target.resolved },
    })
  ).data!;
}
