/**
 * The developer's GitHub account link and the BarnDog GitHub App.
 *
 * GitHub is the only Git host BarnDog integrates with. Everything in this
 * folder calls the server's `/v1/github/…` and `/v1/git-connections/…` routes;
 * the CLI never talks to GitHub itself.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { z } from "zod";
import {
  githubStatusSchema,
  gitAuthorizationSchema,
  gitInstallationSchema,
} from "@barndog-ai/api-contract";
import { connection } from "../collaboration/remote.js";
import { request } from "../environment/remote.js";
import { browserCommand } from "../../shared/browser.js";

export type GithubBrowserOptions = {
  /** `false` returns the URL without opening a browser. */
  browser?: boolean;
};

function openInBrowser(url: string) {
  const { command, args } = browserCommand(url);
  const child = spawn(command, args, { stdio: "ignore" });

  child.once("error", () => undefined);
  child.unref();
}

/** Asks the server for a GitHub page to finish a step on, and opens it. */
async function startInBrowser(
  path: "/v1/github/authorize" | "/v1/github/install",
  step: string,
  options: GithubBrowserOptions,
  home: string,
) {
  const conn = await connection(home);
  const result = await request(conn, path, gitAuthorizationSchema, {
    home,
    method: "POST",
  });

  if (options.browser !== false) {
    openInBrowser(result.url);
  }

  return {
    message: `Complete GitHub ${step} in your browser: ${result.url}`,
  };
}

export async function githubStatus(home = homedir()) {
  const conn = await connection(home);

  return request(conn, "/v1/github/status", githubStatusSchema, { home });
}

/** Links the developer's GitHub account to BarnDog; finished in the browser. */
export function githubAuth(
  options: GithubBrowserOptions = {},
  home = homedir(),
) {
  return startInBrowser("/v1/github/authorize", "authorization", options, home);
}

/** Installs the BarnDog GitHub App on an account or organization; finished in the browser. */
export function githubInstall(
  options: GithubBrowserOptions = {},
  home = homedir(),
) {
  return startInBrowser(
    "/v1/github/install",
    "App installation",
    options,
    home,
  );
}

export async function githubInstallations(home = homedir()) {
  const conn = await connection(home);

  return request(
    conn,
    "/v1/github/installations",
    z.array(gitInstallationSchema),
    { home },
  );
}
