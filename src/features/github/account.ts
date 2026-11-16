/**
 * The developer's GitHub account link and the BarnDog GitHub App.
 *
 * GitHub is the only Git host BarnDog integrates with. Everything in this
 * folder calls the server's `/v1/github/…` and `/v1/git-connections/…` routes;
 * the CLI never talks to GitHub itself.
 */
import type { RuntimeContext } from "../../runtime.js";
import { z } from "zod";
import {
  githubStatusSchema,
  gitAuthorizationSchema,
  gitInstallationSchema,
} from "@barndog-ai/api-contract";
import { connection } from "../server/connection.js";
import { parsed } from "../server/client.js";
import { apiClient } from "../auth/transport.js";

/** The developer's GitHub account link and what the BarnDog GitHub App allows. */
export type GithubStatus = z.infer<typeof githubStatusSchema>;

/** One account or organization the BarnDog GitHub App is installed on. */
export type GithubInstallation = z.infer<typeof gitInstallationSchema>;

/** A GitHub page where the developer finishes a step. */
export type GithubPage = { url: string };

export async function githubStatus(
  runtime: RuntimeContext,
): Promise<GithubStatus> {
  const conn = await connection(runtime);

  return parsed(
    githubStatusSchema,
    apiClient(conn.server, runtime).GET("/v1/github/status"),
  );
}

/** The page that links the developer's GitHub account to BarnDog. */
export async function githubAuth(runtime: RuntimeContext): Promise<GithubPage> {
  const conn = await connection(runtime);
  const { url } = await parsed(
    gitAuthorizationSchema,
    apiClient(conn.server, runtime).POST("/v1/github/authorize"),
  );

  return { url };
}

/** The page that installs the BarnDog GitHub App on an account or organization. */
export async function githubInstall(
  runtime: RuntimeContext,
): Promise<GithubPage> {
  const conn = await connection(runtime);
  const { url } = await parsed(
    gitAuthorizationSchema,
    apiClient(conn.server, runtime).POST("/v1/github/install"),
  );

  return { url };
}

export async function githubInstallations(
  runtime: RuntimeContext,
): Promise<GithubInstallation[]> {
  const conn = await connection(runtime);

  return parsed(
    z.array(gitInstallationSchema),
    apiClient(conn.server, runtime).GET("/v1/github/installations"),
  );
}
