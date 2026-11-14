/**
 * The developer's GitHub account link and the BarnDog GitHub App.
 *
 * GitHub is the only Git host BarnDog integrates with. Everything in this
 * folder calls the server's `/v1/github/…` and `/v1/git-connections/…` routes;
 * the CLI never talks to GitHub itself.
 */
import { homedir } from "node:os";
import { z } from "zod";
import {
  githubStatusSchema,
  gitAuthorizationSchema,
  gitInstallationSchema,
} from "@barndog-ai/api-contract";
import { connection } from "../server/connection.js";
import { request } from "../server/request.js";

/** The developer's GitHub account link and what the BarnDog GitHub App allows. */
export type GithubStatus = z.infer<typeof githubStatusSchema>;

/** One account or organization the BarnDog GitHub App is installed on. */
export type GithubInstallation = z.infer<typeof gitInstallationSchema>;

/** A GitHub page where the developer finishes a step. */
export type GithubPage = { url: string };

async function githubPage(
  path: "/v1/github/authorize" | "/v1/github/install",
  home: string,
): Promise<GithubPage> {
  const conn = await connection(home);
  const { url } = await request(conn, path, gitAuthorizationSchema, {
    home,
    method: "POST",
  });

  return { url };
}

export async function githubStatus(home = homedir()): Promise<GithubStatus> {
  const conn = await connection(home);

  return request(conn, "/v1/github/status", githubStatusSchema, { home });
}

/** The page that links the developer's GitHub account to BarnDog. */
export function githubAuth(home = homedir()): Promise<GithubPage> {
  return githubPage("/v1/github/authorize", home);
}

/** The page that installs the BarnDog GitHub App on an account or organization. */
export function githubInstall(home = homedir()): Promise<GithubPage> {
  return githubPage("/v1/github/install", home);
}

export async function githubInstallations(
  home = homedir(),
): Promise<GithubInstallation[]> {
  const conn = await connection(home);

  return request(
    conn,
    "/v1/github/installations",
    z.array(gitInstallationSchema),
    { home },
  );
}
