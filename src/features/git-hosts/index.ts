import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  gitCopyImportSchema,
  gitCopyImportResultSchema,
  gitCreateRepositorySchema,
  githubStatusSchema,
  gitRemoteHeadSchema,
  gitAuthorizationSchema,
  gitInstallationSchema,
  gitConnectionSchema,
  gitConnectSchema,
  gitImportSchema,
  gitMirrorResolutionSchema,
  gitPullSchema,
  gitPullDetailsSchema,
  gitProposalSchema,
  gitRevisionSchema,
  gitReviewSchema,
  gitCommentSchema,
  gitMergeSchema,
  okSchema,
} from "@barndog-ai/api-contract";
import { readDirectory } from "@barndog-ai/api-contract/collaboration";
import { connection, selectOrigin } from "../collaboration/remote.js";
import { request, selectAsset } from "../environment/remote.js";

export type GitOptions = {
  id?: string;
  kind?: "skill" | "hook";
  name?: string;
  origin?: string;
  installation?: string;
  repository?: string;
  mode?: "connect" | "transfer" | "mirror";
  authority?: "barndog" | "github";
  visibility?: "private" | "public";
  action?: "use-barndog" | "use-mirror" | "disconnect";
  expectedVersion?: string;
  expectedRemote?: string;
  expectedCommit?: string;
  number?: number;
  directory?: string;
  title?: string;
  body?: string;
  bodyFile?: string;
  key?: string;
  event?: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  path?: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
  browser?: boolean;
};

export async function gitOperation(
  action: string,
  options: GitOptions = {},
  home = homedir(),
) {
  const conn = await connection(home),
    key = options.key ?? randomUUID();
  if (action === "status")
    return request(conn, "/v1/github/status", githubStatusSchema, home);
  if (action === "remote-head")
    return request(
      conn,
      `/v1/git-connections/${z.uuidv4().parse(options.id)}/remote-head`,
      gitRemoteHeadSchema,
      home,
    );
  if (action === "auth" || action === "install") {
    const result = await request(
      conn,
      action === "auth" ? "/v1/github/authorize" : "/v1/github/install",
      gitAuthorizationSchema,
      home,
      "POST",
    );
    if (options.browser !== false) {
      const command =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "rundll32"
            : "xdg-open";
      const child = spawn(
        command,
        process.platform === "win32"
          ? ["url.dll,FileProtocolHandler", result.url]
          : [result.url],
        { stdio: "ignore" },
      );
      child.once("error", () => undefined);
      child.unref();
    }
    return {
      message: `Complete GitHub ${action === "auth" ? "authorization" : "App installation"} in your browser: ${result.url}`,
    };
  }
  if (action === "installations")
    return request(
      conn,
      "/v1/github/installations",
      z.array(gitInstallationSchema),
      home,
    );
  if (action === "list")
    return request(
      conn,
      "/v1/git-connections",
      z.array(gitConnectionSchema),
      home,
    );
  if (
    action === "connect" ||
    action === "import" ||
    action === "create-repository"
  ) {
    const parts = options.repository?.split("/");
    if (!parts || parts.length !== 2 || parts.some((p) => !p))
      throw new Error("Use --repository <owner/name>");
    const common = {
      kind: options.kind ?? "skill",
      installationId: options.installation,
      owner: parts[0],
      repository: parts[1],
    };
    if (action === "create-repository") {
      if (!options.key)
        throw new Error("Use --key <key> and retain it for exact retries");
      const selected = await selectAsset(
        common.kind,
        options.name!,
        options.origin!,
        home,
      );
      return request(
        conn,
        "/v1/git-connections/create-repository",
        gitConnectionSchema,
        home,
        "POST",
        gitCreateRepositorySchema.parse({
          ...common,
          assetId: selected.reference.id,
          expectedVersionId:
            options.expectedVersion ?? selected.asset.version.id,
          mode: options.mode ?? "mirror",
          visibility: options.visibility ?? "private",
          idempotencyKey: options.key,
        }),
      );
    }
    if (action === "import") {
      const origin = await selectOrigin(options.origin!, conn, home);
      if (options.authority === "barndog") {
        if (!options.key)
          throw new Error("Use --key <key> and retain it for exact retries");
        return request(
          conn,
          "/v1/git-connections/import-copy",
          gitCopyImportResultSchema,
          home,
          "POST",
          gitCopyImportSchema.parse({
            ...common,
            name: options.name,
            origin: { type: origin.type, id: origin.id },
            idempotencyKey: options.key,
          }),
        );
      }
      const body = gitImportSchema.parse({
        ...common,
        name: options.name,
        origin: { type: origin.type, id: origin.id },
      });
      return request(
        conn,
        "/v1/git-connections/import",
        gitConnectionSchema,
        home,
        "POST",
        body,
      );
    }
    const selected = await selectAsset(
      common.kind,
      options.name!,
      options.origin!,
      home,
    );
    const body = gitConnectSchema.parse({
      ...common,
      assetId: selected.reference.id,
      expectedVersionId: options.expectedVersion ?? selected.asset.version.id,
      mode: options.mode ?? "connect",
    });
    return request(
      conn,
      "/v1/git-connections",
      gitConnectionSchema,
      home,
      "POST",
      body,
    );
  }
  const id = z.uuidv4().parse(options.id),
    path = `/v1/git-connections/${id}`;
  if (action === "show") return request(conn, path, gitConnectionSchema, home);
  if (action === "sync")
    return request(conn, `${path}/sync`, gitConnectionSchema, home, "POST");
  if (action === "mirror-resolve") {
    const body = gitMirrorResolutionSchema.parse({
      action: options.action,
      expectedVersionId: options.expectedVersion,
      expectedRemoteCommit:
        options.expectedRemote === "absent" ? null : options.expectedRemote,
      idempotencyKey: key,
    });
    return request(
      conn,
      `${path}/mirror-resolution`,
      okSchema,
      home,
      "POST",
      body,
    );
  }
  if (action === "pulls-list")
    return request(conn, `${path}/pulls`, z.array(gitPullSchema), home);
  const bodyText = options.bodyFile
    ? await readFile(options.bodyFile, "utf8")
    : (options.body ?? "");
  if (action === "pulls-create" || action === "pulls-revise") {
    const files = (
      await readDirectory(resolve(options.directory ?? process.cwd()))
    ).map((e) => ({
      path: e.path,
      content: e.data.toString("base64"),
      executable: e.executable,
    }));
    const body = (
      action === "pulls-create" ? gitProposalSchema : gitRevisionSchema
    ).parse({
      expectedCommit: options.expectedCommit,
      files,
      title: options.title,
      body: bodyText,
      idempotencyKey: key,
    });
    return request(
      conn,
      action === "pulls-create"
        ? `${path}/pulls`
        : `${path}/pulls/${z.number().int().positive().parse(options.number)}/revisions`,
      gitPullSchema,
      home,
      action === "pulls-create" ? "POST" : "PUT",
      body,
    );
  }
  const number = z.number().int().positive().parse(options.number),
    pull = `${path}/pulls/${number}`;
  if (action === "pulls-show")
    return request(conn, pull, gitPullDetailsSchema, home);
  if (action === "pulls-review")
    return request(
      conn,
      `${pull}/reviews`,
      gitPullDetailsSchema,
      home,
      "POST",
      gitReviewSchema.parse({
        expectedCommit: options.expectedCommit,
        event: options.event,
        body: bodyText,
      }),
    );
  if (action === "pulls-comment")
    return request(
      conn,
      `${pull}/comments`,
      gitPullDetailsSchema,
      home,
      "POST",
      gitCommentSchema.parse({
        expectedCommit: options.expectedCommit,
        body: bodyText,
        path: options.path,
        line: options.line,
        side: options.side,
      }),
    );
  if (action === "pulls-merge")
    return request(
      conn,
      `${pull}/merge`,
      gitConnectionSchema,
      home,
      "PUT",
      gitMergeSchema.parse({ expectedCommit: options.expectedCommit }),
    );
  throw new Error(`Unknown GitHub action: ${action}`);
}
