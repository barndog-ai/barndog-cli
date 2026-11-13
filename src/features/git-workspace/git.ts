import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";

import { CliError, errorCode } from "../../errors.js";
import { GIT_OBJECT_ID } from "../../shared/patterns.js";

/** The prefix Git puts on a failure line: `fatal: `, `error: ` or `remote: `. */
const FAILURE_PREFIX = /^(?:fatal|error|remote):\s*/;

/**
 * The line of Git's stderr that says what went wrong, without its prefix:
 * `fatal: repository 'x' not found` → `repository 'x' not found`. Falls back to
 * the last line when none has a prefix.
 */
export function gitReason(stderr: string) {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const line =
    lines.find((text) => FAILURE_PREFIX.test(text)) ?? lines.at(-1) ?? "";
  return line.replace(FAILURE_PREFIX, "");
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
        const code = errorCode(error) ?? null;
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

/** Git's `ext::` and `fd::` remote helpers, which run commands or read file descriptors. */
const UNSAFE_TRANSPORT = /^(?:ext|fd)::/i;

/** A URL with a password or token in it: `https://user:secret@host/repo.git`. */
const URL_WITH_PASSWORD = /^[a-z][\d+.a-z-]*:\/\/[^/:@]*:[^/@]*@/i;

/** Refuses URLs Git would read as options, helpers, or stored passwords. */
export function checkRepositoryUrl(value: string): string {
  const url = value.trim();
  if (!url || url.startsWith("-") || UNSAFE_TRANSPORT.test(url))
    throw new CliError(`That isn't a Git repository URL: ${url || "(empty)"}`);
  if (URL_WITH_PASSWORD.test(url))
    throw new CliError(
      "Remove the password or token from the URL. BarnDog uses your own Git credentials and never stores them.",
    );
  return url;
}

/** One line of `git ls-remote` output. */
export type RemoteRef = { commit: string; ref: string };

/**
 * The lines of `git ls-remote` output, `<object name>\t<ref>`:
 *
 * ```text
 * 3f786850e387550fdab836ed7e6dc881de23001b\trefs/heads/main
 * ```
 */
export function parseLsRemote(output: string): RemoteRef[] {
  return output
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((fields) => fields.length === 2)
    .map(([commit = "", ref = ""]) => ({ commit, ref }));
}

export type RemoteHead = { branch: string; commit: string } | null;

/** `ref: refs/heads/main\tHEAD` in `git ls-remote --symref <url> HEAD` output. */
const SYMREF_LINE = /^ref: refs\/heads\/(\S+)\s+HEAD$/m;

/** `<object name>\tHEAD` in `git ls-remote` output, in any hash length. */
const HEAD_LINE = /^([\da-f]+)\s+HEAD$/m;

/**
 * Reads the default branch from `git ls-remote --symref <url> HEAD`:
 *
 * ```text
 * ref: refs/heads/main\tHEAD
 * 3f786850e387550fdab836ed7e6dc881de23001b\tHEAD
 * ```
 *
 * Empty output means an empty repository (null). Fails for SHA-256 repositories
 * and when either line is missing.
 */
export function parseRemoteHead(output: string, url: string): RemoteHead {
  if (!output) return null;
  const branch = SYMREF_LINE.exec(output)?.[1];
  const commit = HEAD_LINE.exec(output)?.[1];
  if (commit && !GIT_OBJECT_ID.test(commit))
    throw new CliError(
      "This repository uses SHA-256 object names, which BarnDog doesn't support yet.",
    );
  if (!branch || !commit)
    throw new CliError(`Can't find the default branch of ${url}.`);
  return { branch, commit };
}

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
  return parseRemoteHead(output, url);
}

const identityHint = 'git config --global user.email "you@example.com"';

/**
 * Git's stderr when a commit has no author: `*** Please tell me who you are.`
 * followed by the `git config` commands to run.
 */
export const UNKNOWN_IDENTITY = /tell me who you are/i;

/** Git's "who are you" failure is common on new machines and has one clear fix. */
export function explainIdentity(error: unknown): never {
  if (error instanceof GitError && UNKNOWN_IDENTITY.test(error.stderr))
    throw new CliError(
      "Git doesn't know who you are, so BarnDog can't make a commit.",
      identityHint,
      { cause: error },
    );
  throw error;
}
