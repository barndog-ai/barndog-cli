import { homedir } from "node:os";

import { readSettings } from "../config/settings.js";
import { CliError } from "../errors.js";
import { readCredentials } from "../features/auth/credentials.js";
import { LOCAL_ORIGIN } from "../features/git-workspace/overlay.js";

const cloudOnly = [
  /^login$/,
  /^auth status$/,
  /^whoami$/,
  /^open$/,
  /^people( |$)/,
  /^github( |$)/,
  /^(skills |hooks )?changes( |$)/,
  /^(skills|mcp|hooks) (fork|promote)$/,
  /^mcp (create|update)$/,
];

const needsReview = [
  /^(pull|push|resolve)$/,
  /^(skills|hooks) (pull|push|create|versions|show|diff)$/,
  /^mcp versions$/,
];

export type SetupMode = "local" | "git";

/** The setup this machine runs on, when that setup limits what commands can do. */
export async function currentSetupMode(
  home = homedir(),
): Promise<SetupMode | undefined> {
  const settings = await readSettings(home).catch(() => null);
  if (settings?.version !== 2 || settings.connection) return undefined;
  if (settings.gitWorkspace) return "git";
  return settings.localWorkspace ? "local" : undefined;
}

/** What a command needs that this setup lacks; undefined when it can run. */
export function commandNeeds(
  command: string,
  mode: SetupMode,
): "cloud" | "shared" | undefined {
  if (cloudOnly.some((pattern) => pattern.test(command))) return "cloud";
  if (mode === "local" && needsReview.some((pattern) => pattern.test(command)))
    return "shared";
  return undefined;
}

export type CommandNeed = NonNullable<ReturnType<typeof commandNeeds>>;

export const needText = (need: CommandNeed) =>
  need === "cloud" ? "a Cloud Workspace" : "a Git repo or Cloud Workspace";

export const modeName = (mode: SetupMode) =>
  mode === "local" ? "local" : "Git";

/** Help's note beside a command this setup can't run. */
export const unavailableNote = (need: CommandNeed, mode: SetupMode) =>
  `Not available in ${modeName(mode)} mode. Needs ${needText(need)}.`;

const why: Record<string, string> = {
  login: "signs in to a BarnDog Cloud Workspace",
  "auth status": "shows your BarnDog Cloud Workspace sign-in",
  whoami: "shows your BarnDog Cloud Workspace sign-in",
  open: "opens the BarnDog Cloud Workspace in your browser",
};

/** Stops commands the current setup can't run, before they prompt or reach a server. */
export async function assertCommandAvailable(
  path: string[],
  options: Record<string, unknown> = {},
  home = homedir(),
): Promise<void> {
  const settings = await readSettings(home).catch(() => null);
  if (path.join(" ") === "logout" && !settings) {
    if (!(await readCredentials(home)).selectedServer)
      throw new CliError("You aren't signed in.");
    return;
  }
  if (settings?.version !== 2 || settings.connection) return;
  const git = settings.gitWorkspace;
  const folder = settings.localWorkspace?.path;
  if (!git && !folder) return;
  const command = path.join(" ");
  const where = git
    ? `a Git repo (${git.url})`
    : `a folder on this machine (${folder})`;
  if (command === "logout") {
    const { selectedServer } = await readCredentials(home);
    if (!selectedServer)
      throw new CliError(
        `You aren't signed in. This machine keeps its assets in ${where}, so it doesn't need a sign-in.`,
      );
    return;
  }
  if (git && /^(skills |hooks )?changes( |$)/.test(command))
    throw new CliError(
      `Reviews happen as pull requests on your Git host, because this machine keeps its assets in ${where}.`,
      "barndog status",
    );
  // An explicit server is how local assets get promoted without switching.
  if (command === "login" && options.server) return;
  if (/ promote$/.test(command) && options.origin === LOCAL_ORIGIN) return;
  const needs = commandNeeds(command, git ? "git" : "local");
  if (needs === "cloud") {
    const action = why[command] ?? "needs a BarnDog Cloud Workspace";
    throw new CliError(
      `\`barndog ${command}\` ${action}, but this machine keeps its assets in ${where}.${git ? "" : " Your local assets stay active if you switch."}`,
      "barndog init --server <url>",
    );
  }
  if (needs === "shared")
    throw new CliError(
      `\`barndog ${command}\` works with shared versions and reviews, which assets in a local folder don't have. Edit them directly in ${folder}, then sync.`,
      "barndog sync",
    );
}
