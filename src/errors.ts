import { ApiError } from "@barndog-ai/api-contract";
import { z } from "zod";

/** A user-facing failure with an optional command that fixes it. */
export class CliError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliError";
    this.hint = hint;
  }
}

/** Ends a command early when there is nothing to choose; not a failure. */
export class NothingToDoError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "NothingToDoError";
  }
}

const packageMessages: Record<string, string> = {
  INVALID_SKILL_MD:
    "SKILL.md needs front matter with a lowercase hyphenated name and a description",
  MISSING_SKILL_MD: "This folder has no SKILL.md",
  GITHUB_APP_NOT_CONFIGURED: "GitHub isn't set up on this BarnDog server",
  GITHUB_USER_AUTHORIZATION_REQUIRED:
    "Link your GitHub account first with barndog github auth",
  IDEMPOTENCY_KEY_REUSED:
    "That retry key was already used for different content. Use a new --key",
  ORGANIZATION_ADMIN_REQUIRED: "Only organization admins can do that",
  UNSAFE_PACKAGE_ENTRY: "It contains a link or an unsafe file path",
  CONFLICTING_PACKAGE_PATHS: "A file and a folder share the same path",
  PACKAGE_TOO_LARGE: "It's too large to package",
  EMPTY_HOOK_EVENTS: "hook.yaml lists no events for one of its coding tools",
  CURSOR_COMMAND_HANDLER_REQUIRED:
    "Cursor events in hook.yaml list commands directly, without a nested hooks list",
  NATIVE_MATCHER_GROUP_REQUIRED:
    "Claude Code and Codex events in hook.yaml need a nested hooks list",
  HOOK_COMMAND_MUST_REFERENCE_DECLARED_SCRIPT:
    "Each command in hook.yaml must run a declared script through ${BARNDOG_HOOK_ROOT}/",
};

/** Server refusals people run into, with what to do next when there is something to do. */
const serverProblems: Record<string, { message: string; fix?: string }> = {
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
  if (error instanceof CliError) return error.hint;
  if (error instanceof ApiError) return serverProblems[error.message]?.fix;
  return undefined;
}

/** Turns internal codes and validation errors into something a person can act on. */
export function friendlyMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error instanceof z.ZodError)
    return error.issues
      .map((issue) => {
        const text =
          issue.code === "invalid_format" && issue.format === "uuid"
            ? "That isn't a valid ID. IDs look like 123e4567-e89b-42d3-a456-426614174000."
            : issue.message;
        return issue.path.length ? `${issue.path.join(".")}: ${text}` : text;
      })
      .join("; ");
  if (error instanceof ApiError && serverProblems[error.message])
    return `${serverProblems[error.message]!.message}.`;
  const code = (error as NodeJS.ErrnoException).code;
  const path = (error as NodeJS.ErrnoException).path;
  if (code === "ENOENT" && path) return `Can't find ${path}.`;
  if (code === "EACCES" && path) return `No permission to read ${path}.`;
  if (code === "EISDIR" && path) return `${path} is a folder, not a file.`;
  if (code === "EEXIST" && path)
    return `${path} already exists. Choose another folder or remove it first.`;
  const [prefix, detail] = error.message.split(/: (.*)/s);
  if (prefix === "MISSING_HOOK_SCRIPT")
    return `hook.yaml declares a script that isn't in the folder: ${detail}`;
  if (prefix === "MISSING_PACKAGE_MANIFEST")
    return `This folder has no ${detail}`;
  if (prefix === "UNSAFE_PACKAGE_ENTRY" && detail) return detail;
  if (packageMessages[prefix!]) return packageMessages[prefix!]!;
  // Server codes such as KNOWLEDGE_NOT_FOUND still read as a sentence.
  if (/^[A-Z][A-Z0-9_]+$/.test(error.message))
    return `${error.message[0]}${error.message.slice(1).toLowerCase().replace(/_/g, " ")}.`;
  return error.message;
}
