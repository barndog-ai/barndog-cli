import { synchronize } from "../environment/sync.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { z } from "zod";
import { changeSchema, type Change } from "@barndog-ai/api-contract";
import { collaborationClient, type PackageKind } from "./domain.js";
import { connection, download, getChange, selectSkill } from "./remote.js";
import { readSettings, type GitWorkspace } from "../../config/settings.js";
import { CliError } from "../../errors.js";
import { developers } from "../discovery/index.js";
import { LOCAL_ORIGIN } from "../git-workspace/overlay.js";
import {
  createGitAsset,
  gitHistory,
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

export type CollaborationOptions = {
  kind?: PackageKind;
  name?: string;
  origin?: string;
  directory?: string;
  path?: string;
  publish?: boolean;
  new?: boolean;
  title?: string;
  id?: string;
  revision?: number;
  fromRevision?: number;
  thread?: string;
  body?: string;
  bodyFile?: string;
  side?: "old" | "new";
  startLine?: number;
  endLine?: number;
  replacementFile?: string;
  expectedFile?: string;
  from?: number;
  to?: number;
  version?: number;
};

export type CollaborationAction =
  | "create"
  | "pull-skill"
  | "pull"
  | "status"
  | "diff"
  | "push"
  | "resolve"
  | "list"
  | "show"
  | "change-diff"
  | "approve"
  | "request-changes"
  | "reject"
  | "merge"
  | "comment"
  | "apply"
  | "resolve-discussion"
  | "reopen-discussion"
  | "versions"
  | "version-show"
  | "version-diff";

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

const preview = async (action: "status" | "diff", home: string) =>
  action === "status"
    ? { mode: "environment" }
    : {
        mode: "environment-preview",
        events: await synchronize(undefined, home, undefined, {
          dryRun: true,
        }),
      };

async function collaborateLocal(
  path: string,
  action: CollaborationAction,
  home: string,
) {
  if (action === "status" || action === "diff") return preview(action, home);
  throw new CliError(
    `Local assets have no review step. Edit them directly in ${path}, then sync.`,
    "barndog sync",
  );
}

async function collaborateGit(
  workspace: GitWorkspace,
  action: CollaborationAction,
  options: CollaborationOptions,
  cwd: string,
  home: string,
): Promise<unknown> {
  const asset = {
    name: options.name!,
    origin: options.origin!,
    target: options.directory,
    kind: options.kind,
  };
  switch (action) {
    case "create":
      return createGitAsset(workspace, asset, cwd, home);
    case "pull-skill":
      return pullGitAsset(workspace, asset, cwd, home);
    case "pull":
      return updateGitWorkingCopy(cwd, home);
    case "status":
    case "diff":
      try {
        const working = await gitWorkingStatus(cwd, home);
        return action === "status" ? working : working.changes;
      } catch (error) {
        if (!(error instanceof NoWorkingCopyError)) throw error;
        return preview(action, home);
      }
    case "push":
      return pushGitWorkingCopy(workspace, options, cwd, home);
    case "resolve":
      return resolveGitConflict(options.path!, cwd, home);
    case "versions":
    case "version-show":
    case "version-diff":
      return gitHistory(workspace, action, { ...options, ...asset }, home);
    default:
      throw new CliError(
        "Reviews happen as pull requests on your Git host in a Git repo workspace.",
        "barndog status",
      );
  }
}

export async function collaborate(
  action: CollaborationAction,
  options: CollaborationOptions = {},
  cwd = process.cwd(),
  home = homedir(),
): Promise<unknown> {
  const settings = await readSettings(home);
  if (settings?.version === 2 && settings.gitWorkspace)
    return collaborateGit(settings.gitWorkspace, action, options, cwd, home);
  // A Cloud machine can keep a local folder too; only its own assets stay out of review.
  if (
    settings?.version === 2 &&
    settings.localWorkspace &&
    (!settings.connection || options.origin === LOCAL_ORIGIN)
  )
    return collaborateLocal(settings.localWorkspace.path, action, home);
  switch (action) {
    case "create":
      return createWorkspace(
        options.name!,
        options.origin!,
        options.directory,
        cwd,
        home,
        options.kind,
      );
    case "pull-skill":
      return pullSkill(
        options.name!,
        options.origin!,
        options.directory,
        cwd,
        home,
        options.kind,
      );
    case "pull":
      return updateWorkspace(cwd, home);
    case "status":
    case "diff": {
      try {
        const working = await workspaceStatus(cwd, home);
        return action === "status" ? working : working.changes;
      } catch (error) {
        if (!(error instanceof NoWorkingCopyError)) throw error;
        return action === "status"
          ? { mode: "environment" }
          : {
              mode: "environment-preview",
              events: await synchronize(undefined, home, undefined, {
                dryRun: true,
              }),
            };
      }
    }
    case "push":
      return pushWorkspace(options, cwd, home);
    case "resolve":
      return resolveConflict(options.path!, cwd, home);
  }
  const conn = await connection(home),
    client = collaborationClient(conn.server, home, options.kind);
  if (action === "list") {
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
  if (["versions", "version-show", "version-diff"].includes(action)) {
    const skill = await selectSkill(
      options.name!,
      options.origin!,
      conn,
      home,
      options.kind,
    );
    if (action === "versions") {
      const [rows, names] = await Promise.all([
        client.GET("/v1/skills/{id}/versions", {
          params: { path: { id: skill.id } },
        }),
        developerNames(home),
      ]);
      return rows.data!.map((row) => ({
        ...row,
        publisherName: names[row.publishedBy],
      }));
    }
    if (action === "version-show")
      return (
        await client.GET("/v1/skills/{id}/content", {
          params: {
            path: { id: skill.id },
            query: { version: options.version ?? skill.version.number },
          },
        })
      ).data;
    return (
      await client.GET("/v1/skills/{id}/diff", {
        params: {
          path: { id: skill.id },
          query: { from: options.from!, to: options.to! },
        },
      })
    ).data;
  }
  const id = z.uuid().parse(options.id),
    params = { path: { id } };
  if (action === "show") {
    const change = await getChange(id, conn, home, options.kind);
    const [files, names, versions] = await Promise.all([
      download(
        `/v1/skill-changes/${id}/package?revision=${change.revision}`,
        conn,
        home,
        change.commit,
        options.kind,
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
  if (action === "change-diff")
    return (
      await client.GET("/v1/skill-changes/{id}/diff", {
        params: {
          ...params,
          query: {
            revision: options.revision,
            fromRevision: options.fromRevision,
          },
        },
      })
    ).data;
  const expectedRevision = z.number().int().positive().parse(options.revision),
    body = { expectedRevision };
  if (action === "approve" || action === "request-changes")
    return (
      await client.POST("/v1/skill-changes/{id}/reviews", {
        params,
        body: {
          ...body,
          decision: action === "approve" ? "approve" : "request_changes",
        },
      })
    ).data;
  if (action === "reject")
    return (
      await client.POST("/v1/skill-changes/{id}/reject", { params, body })
    ).data;
  if (action === "merge")
    return (await client.POST("/v1/skill-changes/{id}/merge", { params, body }))
      .data;
  if (action === "comment") {
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
      ).data;
    return (
      await client.POST("/v1/skill-changes/{id}/discussions", {
        params,
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
    ).data;
  }
  const threadParams = {
    path: { id, threadId: z.uuid().parse(options.thread) },
  };
  if (action === "apply")
    return (
      await client.POST("/v1/skill-changes/{id}/discussions/{threadId}/apply", {
        params: threadParams,
        body,
      })
    ).data;
  return (
    await client.POST("/v1/skill-changes/{id}/discussions/{threadId}/resolve", {
      params: threadParams,
      body: { ...body, resolved: action === "resolve-discussion" },
    })
  ).data;
}
