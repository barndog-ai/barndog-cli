/**
 * Pull requests on the GitHub repository behind a connection, for assets
 * GitHub is authoritative for. Every call goes to the BarnDog server, never
 * to GitHub itself.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  gitConnectionSchema,
  gitPullSchema,
  gitPullDetailsSchema,
  gitProposalSchema,
  gitRevisionSchema,
  gitReviewSchema,
  gitCommentSchema,
  gitMergeSchema,
  type GitConnection,
} from "@barndog-ai/api-contract";
import { readDirectory } from "@barndog-ai/api-contract/collaboration";
import { connection } from "../server/connection.js";
import { type RetryKey, parsed } from "../server/client.js";
import { connectionParams } from "./connections.js";
import { apiClient } from "../auth/transport.js";

export type GitPull = z.infer<typeof gitPullSchema>;

/** A pull request with its diff, reviews and comments. */
export type GitPullDetails = z.infer<typeof gitPullDetailsSchema>;

/** Text given directly or in a file; the file wins. */
type PullText = { body?: string; bodyFile?: string };

type PullReference = { connectionId: string; number: number };

type PullPackage = PullText & {
  /** Folder holding the complete package; the working directory by default. */
  directory?: string;
  key?: RetryKey;
};

/**
 * A new pull request whose content is the complete package in `directory`,
 * starting from the inspected canonical commit.
 */
export type GithubPullsCreateOptions = PullPackage & {
  connectionId: string;
  /** The inspected canonical commit the edits start from. */
  expectedCommit: string;
  title: string;
};

/**
 * A new revision of an open pull request, refused if its head moved since
 * `expectedCommit` was inspected.
 */
export type GithubPullsReviseOptions = PullPackage &
  PullReference & {
    /** The inspected pull head commit. */
    expectedCommit: string;
    title?: string;
  };

/** A review on the inspected head commit. */
export type GithubPullsReviewOptions = PullText &
  PullReference & {
    expectedCommit: string;
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  };

/**
 * A comment on the inspected head commit: general, or inline when `path`,
 * `line` and `side` are given.
 */
export type GithubPullsCommentOptions = PullText &
  PullReference & {
    expectedCommit: string;
    path?: string;
    line?: number;
    side?: "LEFT" | "RIGHT";
  };

/** A merge of the inspected head commit. */
export type GithubPullsMergeOptions = PullReference & {
  expectedCommit: string;
};

const bodyText = async (options: PullText) =>
  options.bodyFile
    ? await readFile(options.bodyFile, "utf8")
    : (options.body ?? "");

/** The path parameters of one pull request's routes. */
const pullParams = (connectionId: string, number: number) => ({
  path: {
    ...connectionParams(connectionId).path,
    number: z.number().int().positive().parse(number),
  },
});

/** Every file of the package, as the server's proposal routes take them. */
async function packageFiles(directory: string | undefined) {
  const entries = await readDirectory(resolve(directory ?? process.cwd()));

  return entries.map((entry) => ({
    path: entry.path,
    content: entry.data.toString("base64"),
    executable: entry.executable,
  }));
}

export async function githubPullsList(
  connectionId: string,
  home: string,
): Promise<GitPull[]> {
  const conn = await connection(home);

  return parsed(
    z.array(gitPullSchema),
    apiClient(conn.server, home).GET("/v1/git-connections/{id}/pulls", {
      params: connectionParams(connectionId),
    }),
  );
}

/** One pull request with its reviews and comments. */
export async function githubPullsShow(
  connectionId: string,
  number: number,
  home: string,
): Promise<GitPullDetails> {
  const conn = await connection(home);

  return parsed(
    gitPullDetailsSchema,
    apiClient(conn.server, home).GET(
      "/v1/git-connections/{id}/pulls/{number}",
      {
        params: pullParams(connectionId, number),
      },
    ),
  );
}

/** Opens a pull request whose content is the complete package, not a patch. */
export async function githubPullsCreate(
  options: GithubPullsCreateOptions,
  home: string,
): Promise<GitPull> {
  const conn = await connection(home);
  const body = await bodyText(options);
  const proposal = gitProposalSchema.parse({
    expectedCommit: options.expectedCommit,
    files: await packageFiles(options.directory),
    title: options.title,
    body,
    idempotencyKey: options.key ?? randomUUID(),
  });

  return parsed(
    gitPullSchema,
    apiClient(conn.server, home).POST("/v1/git-connections/{id}/pulls", {
      params: connectionParams(options.connectionId),
      body: proposal,
    }),
  );
}

/** Replaces an open pull request's content with the complete package. */
export async function githubPullsRevise(
  options: GithubPullsReviseOptions,
  home: string,
): Promise<GitPull> {
  const conn = await connection(home);
  const body = await bodyText(options);
  const revision = gitRevisionSchema.parse({
    expectedCommit: options.expectedCommit,
    files: await packageFiles(options.directory),
    title: options.title,
    body,
    idempotencyKey: options.key ?? randomUUID(),
  });

  return parsed(
    gitPullSchema,
    apiClient(conn.server, home).PUT(
      "/v1/git-connections/{id}/pulls/{number}/revisions",
      {
        params: pullParams(options.connectionId, options.number),
        body: revision,
      },
    ),
  );
}

/**
 * Approves, requests changes or comments on a pull request at the inspected
 * head commit. Reads `bodyFile` when given.
 */
export async function githubPullsReview(
  options: GithubPullsReviewOptions,
  home: string,
): Promise<GitPullDetails> {
  const conn = await connection(home);
  const body = await bodyText(options);

  return parsed(
    gitPullDetailsSchema,
    apiClient(conn.server, home).POST(
      "/v1/git-connections/{id}/pulls/{number}/reviews",
      {
        params: pullParams(options.connectionId, options.number),
        body: gitReviewSchema.parse({
          expectedCommit: options.expectedCommit,
          event: options.event,
          body,
        }),
      },
    ),
  );
}

/** A general comment, or an inline one when `path`, `line` and `side` are given. */
export async function githubPullsComment(
  options: GithubPullsCommentOptions,
  home: string,
): Promise<GitPullDetails> {
  const conn = await connection(home);
  const body = await bodyText(options);

  return parsed(
    gitPullDetailsSchema,
    apiClient(conn.server, home).POST(
      "/v1/git-connections/{id}/pulls/{number}/comments",
      {
        params: pullParams(options.connectionId, options.number),
        body: gitCommentSchema.parse({
          expectedCommit: options.expectedCommit,
          body,
          path: options.path,
          line: options.line,
          side: options.side,
        }),
      },
    ),
  );
}

/** Returns the connection, now at the merged commit, rather than the pull request. */
export async function githubPullsMerge(
  options: GithubPullsMergeOptions,
  home: string,
): Promise<GitConnection> {
  const conn = await connection(home);

  return parsed(
    gitConnectionSchema,
    apiClient(conn.server, home).PUT(
      "/v1/git-connections/{id}/pulls/{number}/merge",
      {
        params: pullParams(options.connectionId, options.number),
        body: gitMergeSchema.parse({ expectedCommit: options.expectedCommit }),
      },
    ),
  );
}
