import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";

import { CliError } from "../../errors.js";

/** The line of Git's output that says what went wrong. */
export function gitReason(stderr: string) {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const line =
    lines.find((text) => /^(fatal|error|remote):/.test(text)) ??
    lines.at(-1) ??
    "";
  return line.replace(/^(fatal|error|remote):\s*/, "");
}

/** Git can't read the repository with what this machine has set up. */
export class RepositoryAccessError extends CliError {}

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | string | null,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export type GitOptions = {
  /** The repository to run in; omitted for commands that take a URL. */
  repo?: string;
  input?: Buffer | string;
  env?: Record<string, string>;
  /** Only setup may ask for credentials; background work must never hang on a prompt. */
  allowPrompt?: boolean;
  timeoutMs?: number;
};

// A caller running inside a Git hook passes these, and they would redirect every command.
const inherited = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"];

/** Runs system Git with repository hooks and the arbitrary-command transport disabled. */
export function git(args: string[], options: GitOptions = {}): Promise<Buffer> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of inherited) delete env[name];
  if (!options.allowPrompt) env.GIT_TERMINAL_PROMPT = "0";
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [
        ...(options.repo ? ["-C", options.repo] : []),
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "protocol.ext.allow=never",
        ...args,
      ],
      {
        encoding: "buffer",
        env: { ...env, ...options.env },
        maxBuffer: 512 * 1024 * 1024,
        timeout: options.timeoutMs ?? 180_000,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const code = (error as NodeJS.ErrnoException).code ?? null;
        if (code === "ENOENT")
          return reject(
            new CliError(
              "Git isn't installed or isn't on your PATH. Git repo workspaces need it.",
            ),
          );
        const text = stderr.toString("utf8").trim();
        reject(new GitError(text || error.message, text, code));
      },
    );
    child.stdin?.end(options.input);
  });
}

/** Runs Git attached to the terminal, so its own prompts and errors reach the developer. */
export function gitInTerminal(args: string[]): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of inherited) delete env[name];
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "protocol.ext.allow=never",
        ...args,
      ],
      { env, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new GitError(`git exited with ${code}`, "", code)),
    );
  });
}

export const gitText = async (args: string[], options?: GitOptions) =>
  (await git(args, options)).toString("utf8").trim();

/** Lets `--repo` name a clone on disk: the workspace is the remote it came from. */
export async function cloneOrigin(value: string): Promise<string> {
  try {
    if (!(await stat(value.trim())).isDirectory()) return value;
    return await gitText(["config", "--get", "remote.origin.url"], {
      repo: value.trim(),
    });
  } catch {
    return value;
  }
}

/** Refuses URLs Git would read as options, helpers, or stored passwords. */
export function checkRepositoryUrl(value: string): string {
  const url = value.trim();
  if (!url || url.startsWith("-") || /^(ext|fd)::/i.test(url))
    throw new CliError(`That isn't a Git repository URL: ${url || "(empty)"}`);
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/i.test(url))
    throw new CliError(
      "Remove the password or token from the URL. BarnDog uses your own Git credentials and never stores them.",
    );
  return url;
}

const FORTY_HEX = /^[0-9a-f]{40}$/;

export type RemoteHead = { branch: string; commit: string } | null;

/** Reads a remote's default branch; null means the repository is empty. */
export async function remoteHead(
  url: string,
  allowPrompt = false,
): Promise<RemoteHead> {
  let output: string;
  try {
    output = await gitText(["ls-remote", "--symref", "--", url, "HEAD"], {
      allowPrompt,
      timeoutMs: 60_000,
    });
  } catch (error) {
    if (error instanceof GitError)
      throw new RepositoryAccessError(
        `Can't read ${url} with your Git credentials: ${gitReason(error.stderr)}`,
        `git clone ${url}`,
        { cause: error },
      );
    throw error;
  }
  if (!output) return null;
  const branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(output)?.[1];
  const commit = /^([0-9a-f]+)\s+HEAD$/m.exec(output)?.[1];
  if (commit && !FORTY_HEX.test(commit))
    throw new CliError(
      "This repository uses SHA-256 object names, which BarnDog doesn't support yet.",
    );
  if (!branch || !commit)
    throw new CliError(`Can't find the default branch of ${url}.`);
  return { branch, commit };
}

const identityHint = 'git config --global user.email "you@example.com"';

/** Git's "who are you" failure is common on new machines and has one clear fix. */
export function explainIdentity(error: unknown): never {
  if (error instanceof GitError && /tell me who you are/i.test(error.stderr))
    throw new CliError(
      "Git doesn't know who you are, so BarnDog can't make a commit.",
      identityHint,
      { cause: error },
    );
  throw error;
}
