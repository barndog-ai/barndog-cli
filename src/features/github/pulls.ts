/**
 * Pull requests on the GitHub repository behind a connection, for assets
 * GitHub is authoritative for. Every call goes to the BarnDog server, never
 * to GitHub itself.
 */
import { homedir } from "node:os";
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
} from "@barndog-ai/api-contract";
import { readDirectory } from "@barndog-ai/api-contract/collaboration";
import { connection } from "../collaboration/remote.js";
import { request, type RetryKey } from "../environment/remote.js";
import { connectionPath } from "./connections.js";

/** Text given directly or in a file; the file wins. */
type PullText = { body?: string; bodyFile?: string };

type PullReference = { connectionId: string; number: number };

type PullPackage = PullText & {
  /** Folder holding the complete package; the working directory by default. */
  directory?: string;
  key?: RetryKey;
};

export type GithubPullsCreateOptions = PullPackage & {
  connectionId: string;
  /** The inspected canonical commit the edits start from. */
  expectedCommit: string;
  title: string;
};

export type GithubPullsReviseOptions = PullPackage &
  PullReference & {
    /** The inspected pull head commit. */
    expectedCommit: string;
    title?: string;
  };

export type GithubPullsReviewOptions = PullText &
  PullReference & {
    expectedCommit: string;
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  };

export type GithubPullsCommentOptions = PullText &
  PullReference & {
    expectedCommit: string;
    path?: string;
    line?: number;
    side?: "LEFT" | "RIGHT";
  };

export type GithubPullsMergeOptions = PullReference & {
  expectedCommit: string;
};

const bodyText = async (options: PullText) =>
  options.bodyFile
    ? await readFile(options.bodyFile, "utf8")
    : (options.body ?? "");

const pullNumber = (number: number) =>
  z.number().int().positive().parse(number);

/** Every file of the package, as the server's proposal routes take them. */
async function packageFiles(directory: string | undefined) {
  const entries = await readDirectory(resolve(directory ?? process.cwd()));

  return entries.map((entry) => ({
    path: entry.path,
    content: entry.data.toString("base64"),
    executable: entry.executable,
  }));
}

export async function githubPullsList(connectionId: string, home = homedir()) {
  const conn = await connection(home);

  return request(
    conn,
    `${connectionPath(connectionId)}/pulls`,
    z.array(gitPullSchema),
    { home },
  );
}

/** One pull request with its reviews and comments. */
export async function githubPullsShow(
  connectionId: string,
  number: number,
  home = homedir(),
) {
  const conn = await connection(home);

  return request(
    conn,
    `${connectionPath(connectionId)}/pulls/${pullNumber(number)}`,
    gitPullDetailsSchema,
    { home },
  );
}

/** Opens a pull request whose content is the complete package, not a patch. */
export async function githubPullsCreate(
  options: GithubPullsCreateOptions,
  home = homedir(),
) {
  const conn = await connection(home);
  const path = connectionPath(options.connectionId);
  const body = await bodyText(options);
  const proposal = gitProposalSchema.parse({
    expectedCommit: options.expectedCommit,
    files: await packageFiles(options.directory),
    title: options.title,
    body,
    idempotencyKey: options.key ?? randomUUID(),
  });

  return request(conn, `${path}/pulls`, gitPullSchema, {
    home,
    method: "POST",
    body: proposal,
  });
}

/** Replaces an open pull request's content with the complete package. */
export async function githubPullsRevise(
  options: GithubPullsReviseOptions,
  home = homedir(),
) {
  const conn = await connection(home);
  const path = connectionPath(options.connectionId);
  const body = await bodyText(options);
  const revision = gitRevisionSchema.parse({
    expectedCommit: options.expectedCommit,
    files: await packageFiles(options.directory),
    title: options.title,
    body,
    idempotencyKey: options.key ?? randomUUID(),
  });

  return request(
    conn,
    `${path}/pulls/${pullNumber(options.number)}/revisions`,
    gitPullSchema,
    { home, method: "PUT", body: revision },
  );
}

export async function githubPullsReview(
  options: GithubPullsReviewOptions,
  home = homedir(),
) {
  const conn = await connection(home);
  const path = connectionPath(options.connectionId);
  const body = await bodyText(options);

  return request(
    conn,
    `${path}/pulls/${pullNumber(options.number)}/reviews`,
    gitPullDetailsSchema,
    {
      home,
      method: "POST",
      body: gitReviewSchema.parse({
        expectedCommit: options.expectedCommit,
        event: options.event,
        body,
      }),
    },
  );
}

/** A general comment, or an inline one when `path`, `line` and `side` are given. */
export async function githubPullsComment(
  options: GithubPullsCommentOptions,
  home = homedir(),
) {
  const conn = await connection(home);
  const path = connectionPath(options.connectionId);
  const body = await bodyText(options);

  return request(
    conn,
    `${path}/pulls/${pullNumber(options.number)}/comments`,
    gitPullDetailsSchema,
    {
      home,
      method: "POST",
      body: gitCommentSchema.parse({
        expectedCommit: options.expectedCommit,
        body,
        path: options.path,
        line: options.line,
        side: options.side,
      }),
    },
  );
}

/** Returns the connection, now at the merged commit, rather than the pull request. */
export async function githubPullsMerge(
  options: GithubPullsMergeOptions,
  home = homedir(),
) {
  const conn = await connection(home);
  const path = connectionPath(options.connectionId);

  return request(
    conn,
    `${path}/pulls/${pullNumber(options.number)}/merge`,
    gitConnectionSchema,
    {
      home,
      method: "PUT",
      body: gitMergeSchema.parse({ expectedCommit: options.expectedCommit }),
    },
  );
}
