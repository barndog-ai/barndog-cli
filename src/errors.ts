import { ApiError } from "@barndog-ai/api-contract";
import { z } from "zod";

import { CliError } from "./shared/cli-error.js";
import { CONSTANT_CASE } from "./shared/patterns.js";
import { errorCode } from "./shared/values.js";

export { CliError };

/** Ends a command early when there is nothing to choose; not a failure. */
export class NothingToDoError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "NothingToDoError";
  }
}

/**
 * Why a folder or archive can't be a package. The CLI throws these as
 * `PackageError`; `@barndog-ai/api-contract`'s package helpers throw the same
 * codes as plain `Error` messages, and the server returns them as `ApiError`s,
 * so `packageError()` translates both at that boundary.
 *
 * @internal Exported for the completeness test in `src/tests/errors.test.ts`.
 */
export const packageProblemCodes = [
  "CONFLICTING_PACKAGE_PATHS",
  "CURSOR_COMMAND_HANDLER_REQUIRED",
  "EMPTY_HOOK_EVENTS",
  "HOOK_COMMAND_MUST_REFERENCE_DECLARED_SCRIPT",
  "INVALID_SKILL_MD",
  "MISSING_HOOK_SCRIPT",
  "MISSING_PACKAGE_MANIFEST",
  "MISSING_SKILL_MD",
  "MODIFIED_CACHED_PACKAGE",
  "NATIVE_MATCHER_GROUP_REQUIRED",
  "PACKAGE_TOO_LARGE",
  "UNSAFE_PACKAGE_ENTRY",
] as const;

export type PackageProblemCode = (typeof packageProblemCodes)[number];

function isPackageProblemCode(value: string): value is PackageProblemCode {
  return packageProblemCodes.some((code) => code === value);
}

/**
 * A package the CLI can't read, write or submit. `detail` names the file
 * involved, such as the missing manifest or the unsafe path.
 */
export class PackageError extends Error {
  readonly code: PackageProblemCode;

  readonly detail?: string;

  constructor(
    code: PackageProblemCode,
    detail?: string,
    options?: ErrorOptions,
  ) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = "PackageError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * `error` as a `PackageError`: itself, or a package code from the contract's
 * helpers (`Error("MISSING_HOOK_SCRIPT: run.sh")`) or the server. Those two
 * report codes only as message text; this is the one place that reads it.
 */
function packageError(error: unknown): PackageError | undefined {
  if (error instanceof PackageError) {
    return error;
  }

  if (!(error instanceof Error) || error instanceof CliError) {
    return undefined;
  }

  const separator = error.message.indexOf(": ");
  const code =
    separator < 0 ? error.message : error.message.slice(0, separator);

  if (!isPackageProblemCode(code)) {
    return undefined;
  }

  const detail = separator < 0 ? undefined : error.message.slice(separator + 2);

  return new PackageError(code, detail, { cause: error });
}

/** `text`, followed by the file it's about when there is one. */
const about = (text: string, detail?: string) =>
  detail ? `${text}: ${detail}` : text;

/** What a package problem means to the person whose folder it is. */
function packageProblem({ code, detail }: PackageError): string {
  switch (code) {
    case "CONFLICTING_PACKAGE_PATHS":
      return "A file and a folder share the same path";
    case "CURSOR_COMMAND_HANDLER_REQUIRED":
      return "Cursor events in hook.yaml list commands directly, without a nested hooks list";
    case "EMPTY_HOOK_EVENTS":
      return "hook.yaml lists no events for one of its coding tools";
    case "HOOK_COMMAND_MUST_REFERENCE_DECLARED_SCRIPT":
      return "Each command in hook.yaml must run a declared script through ${BARNDOG_HOOK_ROOT}/";
    case "INVALID_SKILL_MD":
      return "SKILL.md needs front matter with a lowercase hyphenated name and a description";
    case "MISSING_HOOK_SCRIPT":
      return about(
        "hook.yaml declares a script that isn't in the folder",
        detail,
      );
    case "MISSING_PACKAGE_MANIFEST":
      return `This folder has no ${detail || "manifest file"}`;
    case "MISSING_SKILL_MD":
      return "This folder has no SKILL.md";
    case "MODIFIED_CACHED_PACKAGE":
      return "A downloaded copy was changed on this machine, so BarnDog won't reuse it";
    case "NATIVE_MATCHER_GROUP_REQUIRED":
      return "Claude Code and Codex events in hook.yaml need a nested hooks list";
    case "PACKAGE_TOO_LARGE":
      return "It's too large to package";
    case "UNSAFE_PACKAGE_ENTRY":
      return about("It contains a link or an unsafe file path", detail);
  }
}

/**
 * Server refusal codes the CLI explains; others read as a sentence (see
 * `friendlyMessage`).
 *
 * @internal Exported for the completeness test in `src/tests/errors.test.ts`.
 */
export const serverProblemCodes = [
  "APPROVALS_REQUIRED",
  "CHANGE_AUTHOR_REQUIRED",
  "CHANGE_CLOSED",
  "CHANGE_CLOSE_FORBIDDEN",
  "CHANGES_REQUESTED",
  "GITHUB_APP_NOT_CONFIGURED",
  "GITHUB_USER_AUTHORIZATION_REQUIRED",
  "IDEMPOTENCY_KEY_REUSED",
  "MCP_NOT_FOUND",
  "MERGE_ADMIN_REQUIRED",
  "MERGE_MEMBERSHIP_REQUIRED",
  "NO_CHANGES",
  "ORGANIZATION_ADMIN_REQUIRED",
  "OUTDATED_SUGGESTION",
  "PERSONAL_OWNER_REQUIRED",
  "PUBLICATION_FORBIDDEN",
  "REVIEW_MEMBERSHIP_REQUIRED",
  "SCOPE_ADMIN_REQUIRED",
  "SCOPE_MEMBERSHIP_REQUIRED",
  "SCOPE_NOT_FOUND",
  "SELF_REVIEW_FORBIDDEN",
  "SKILL_NOT_FOUND",
  "STALE_CHANGE_REVISION",
  "STALE_SKILL_VERSION",
  "SUGGESTION_CONTENT_MISMATCH",
  "THREAD_ACTION_FORBIDDEN",
] as const;

type ServerProblemCode = (typeof serverProblemCodes)[number];

/**
 * The server's specific refusal code, such as `STALE_SKILL_VERSION`. The API
 * sends it in the body's `message` field (its `code` field holds only the HTTP
 * category, such as `CONFLICT`), so `ApiError.message` carries it.
 */
function serverCode(error: ApiError): string {
  return error.message;
}

function serverProblemCode(error: unknown): ServerProblemCode | undefined {
  if (!(error instanceof ApiError)) {
    return undefined;
  }

  const code = serverCode(error);

  return serverProblemCodes.find((known) => known === code);
}

/** Server refusals people run into, with what to do next when there is something to do. */
const serverProblems: Record<
  ServerProblemCode,
  { message: string; fix?: string }
> = {
  APPROVALS_REQUIRED: {
    message: "This change needs more approvals before it can merge",
    fix: "barndog changes list",
  },
  CHANGE_AUTHOR_REQUIRED: {
    message: "Only the author of this change can revise it",
    fix: "barndog push --new",
  },
  CHANGE_CLOSED: {
    message: "This change is closed",
    fix: "barndog push --new",
  },
  CHANGE_CLOSE_FORBIDDEN: {
    message: "Only its author or an admin can close this change",
  },
  CHANGES_REQUESTED: {
    message: "A reviewer requested changes, so this can't merge yet",
    fix: "barndog changes list",
  },
  GITHUB_APP_NOT_CONFIGURED: {
    message: "GitHub isn't set up on this BarnDog server",
  },
  GITHUB_USER_AUTHORIZATION_REQUIRED: {
    message: "Link your GitHub account first",
    fix: "barndog github auth",
  },
  IDEMPOTENCY_KEY_REUSED: {
    message:
      "That retry key was already used for different content. Use a new --key",
  },
  MCP_NOT_FOUND: {
    message: "No MCP server matches that name and origin",
    fix: "barndog mcp search",
  },
  MERGE_ADMIN_REQUIRED: { message: "Only admins can merge changes here" },
  MERGE_MEMBERSHIP_REQUIRED: {
    message: "Only members of this team or repository can merge its changes",
  },
  NO_CHANGES: {
    message: "Nothing differs from the published version",
    fix: "barndog status",
  },
  ORGANIZATION_ADMIN_REQUIRED: {
    message: "Only organization admins can do that",
  },
  OUTDATED_SUGGESTION: {
    message: "That suggestion no longer applies to the current revision",
    fix: "barndog changes list",
  },
  PERSONAL_OWNER_REQUIRED: { message: "Only its owner can do that" },
  PUBLICATION_FORBIDDEN: {
    message: "You can't publish here directly. Propose it for review instead",
    fix: "barndog push",
  },
  REVIEW_MEMBERSHIP_REQUIRED: {
    message: "Only members of this team or repository can review its changes",
  },
  SCOPE_ADMIN_REQUIRED: { message: "Only an admin of this scope can do that" },
  SCOPE_MEMBERSHIP_REQUIRED: { message: "You aren't a member of this scope" },
  SCOPE_NOT_FOUND: {
    message: "No scope matches that origin",
    fix: "barndog sets list",
  },
  SELF_REVIEW_FORBIDDEN: {
    message: "You can't review your own change. Ask a teammate to review it",
  },
  SKILL_NOT_FOUND: {
    message: "No Skill matches that name and origin",
    fix: "barndog skills search",
  },
  STALE_CHANGE_REVISION: {
    message: "This change has a newer revision. Review it, then retry",
    fix: "barndog changes list",
  },
  STALE_SKILL_VERSION: {
    message: "A newer version was published after this change was made",
    fix: "barndog pull",
  },
  SUGGESTION_CONTENT_MISMATCH: {
    message:
      "--expected-file doesn't match those lines in this revision. Suggestions also need --side new",
    fix: "barndog changes list",
  },
  THREAD_ACTION_FORBIDDEN: {
    message: "Only the discussion's author or an admin can do that",
  },
};

/** The next command for a server refusal or a CliError, when one is known. */
export function friendlyHint(error: unknown): string | undefined {
  if (error instanceof CliError) {
    return error.hint;
  }

  const code = serverProblemCode(error);

  return code ? serverProblems[code].fix : undefined;
}

/** Turns internal codes and validation errors into something a person can act on. */
export function friendlyMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => {
        const text =
          issue.code === "invalid_format" && issue.format === "uuid"
            ? "That isn't a valid ID. IDs look like 123e4567-e89b-42d3-a456-426614174000."
            : issue.message;

        return issue.path.length ? `${issue.path.join(".")}: ${text}` : text;
      })
      .join("; ");
  }

  const packaged = packageError(error);
  if (packaged) {
    return packageProblem(packaged);
  }

  const server = serverProblemCode(error);
  if (server) {
    return `${serverProblems[server].message}.`;
  }

  // Other server codes, such as KNOWLEDGE_NOT_FOUND, still read as a sentence.
  if (error instanceof ApiError && CONSTANT_CASE.test(serverCode(error))) {
    const code = serverCode(error);

    return `${code[0]}${code.slice(1).toLowerCase().replaceAll("_", " ")}.`;
  }

  const code = errorCode(error);
  const path =
    "path" in error && typeof error.path === "string" ? error.path : undefined;

  if (code === "ENOENT" && path) {
    return `Can't find ${path}.`;
  }

  if (code === "EACCES" && path) {
    return `No permission to read ${path}.`;
  }

  if (code === "EISDIR" && path) {
    return `${path} is a folder, not a file.`;
  }

  if (code === "EEXIST" && path) {
    return `${path} already exists. Choose another folder or remove it first.`;
  }

  return error.message;
}
