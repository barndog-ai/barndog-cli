import { primary } from "./theme.js";
import { renderSyncOutput } from "./output.js";
import { changeSchema } from "@barndog-ai/api-contract";
import { textContent } from "@barndog-ai/api-contract/collaboration";
import type { CollaborationAction } from "../features/collaboration/index.js";

// Remote package text must not be able to emit terminal control sequences.
export function safe(value: unknown) {
  return String(value).replace(
    // eslint-disable-next-line no-control-regex
    /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function files(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((file) => {
    const text = textContent(Buffer.from(file.content, "base64"));
    return [
      primary(`${safe(file.path)}${file.executable ? " (executable)" : ""}`),
      text === null ? "Binary file" : safe(text),
    ];
  });
}

/** Mode changes are worth a mention; a new file having no old mode isn't. */
function executableNote(previous: unknown, next: unknown) {
  if (previous === next || next === null || next === undefined) return "";
  if (previous === null || previous === undefined)
    return next ? "  executable" : "";
  return `  executable: ${previous} → ${next}`;
}

export function renderCollaboration(
  action: CollaborationAction,
  value: unknown,
): string[] {
  if (Array.isArray(value)) {
    if (!value.length) return ["No changes."];
    return value.flatMap((row) => {
      if (row && "patch" in row)
        return [
          `${safe(row.kind)}  ${safe(row.path)}${row.binary ? " (binary)" : ""}${executableNote(row.oldExecutable, row.newExecutable)}`,
          safe(row.patch),
        ].filter(Boolean);
      if (row && "status" in row)
        return [
          `${safe(row.name)}  ${safe(row.status)}  revision ${row.revision}\n  ${safe(row.id)}  ${safe(row.title)}`,
        ];
      if (row && "number" in row)
        return [
          `v${row.number}  ${row.commit}\n  ${safe(row.description)}  published by ${safe(row.publisherName ?? row.publishedBy)}`,
        ];
      return [safe(JSON.stringify(row, null, 2))];
    });
  }
  const parsed = changeSchema.safeParse(value);
  if (parsed.success) {
    const change = parsed.data;
    const rows = [
      primary(
        `${change.status === "merged" ? "Published" : "Suggested Change"}  ${change.id}`,
      ),
      safe(
        `${change.title}  ·  ${change.status}  ·  revision ${change.revision}`,
      ),
    ];
    if (action === "show") {
      const details = value as {
        names?: Record<string, string>;
        baseVersionNumber?: number;
      };
      const person = (id: string) => safe(details.names?.[id] ?? id);
      rows.push(
        `Author: ${person(change.authorId)}`,
        `Base: ${details.baseVersionNumber ? `v${details.baseVersionNumber}` : (change.baseVersionId ?? "new package")}`,
      );
      for (const review of change.reviews)
        rows.push(
          `Review: ${review.decision}  revision ${review.revision}  ${person(review.developerId)}`,
        );
      for (const thread of change.threads) {
        rows.push(
          `\nDiscussion ${thread.id}  revision ${thread.revision}${thread.outdated ? " (outdated)" : ""}${thread.resolved ? " (resolved)" : ""}${thread.path ? `  ${safe(thread.path)}:${thread.startLine}-${thread.endLine} (${thread.side})` : ""}`,
        );
        for (const comment of thread.comments)
          rows.push(`  ${person(comment.authorId)}: ${safe(comment.body)}`);
        if (thread.replacement !== null)
          rows.push("  Suggested replacement:", safe(thread.replacement));
      }
      if (value && typeof value === "object" && "files" in value)
        rows.push("", ...files(value.files));
    }
    return rows;
  }
  if (value && typeof value === "object") {
    if (
      "mode" in value &&
      value.mode === "environment-preview" &&
      "events" in value
    ) {
      return renderSyncOutput(
        value.events as import("../features/skills/sync.js").SyncEvent[],
        { title: "preview", preview: true },
      );
    }
    if ("files" in value) return files(value.files);
    if ("unchanged" in value) return ["Package unchanged."];
    if ("branch" in value && "commit" in value) {
      const pushed = value as {
        branch: string;
        commit: string;
        published?: boolean;
        url?: string | null;
        opened?: boolean;
      };
      if (pushed.published)
        return [primary(`Pushed to ${safe(pushed.branch)}`), pushed.commit];
      return [
        primary(`Pushed ${safe(pushed.branch)}`),
        pushed.url
          ? `${pushed.opened ? "Pull request" : "Open the pull request"}: ${safe(pushed.url)}`
          : "Open a pull request from this branch on your Git host.",
      ];
    }
    if ("changes" in value && "root" in value) {
      const status = value as {
        root: string;
        name: string;
        baseVersion: number | null;
        baseCommit?: string;
        review?: { branch: string; url: string | null } | null;
        proposal: { id: string; revision: number } | null;
        external?: {
          connectionId: string;
          pull: { number: number; head: string } | null;
        };
        conflicts: string[];
        pending: boolean;
        changes: unknown[];
      };
      return [
        primary(`${safe(status.name)}  ${safe(status.root)}`),
        `Base: ${status.baseCommit ? status.baseCommit.slice(0, 7) : status.baseVersion ? `v${status.baseVersion}` : "new package"}`,
        ...(status.review
          ? [
              `Review branch: ${safe(status.review.branch)}${status.review.url ? `  ${safe(status.review.url)}` : ""}`,
            ]
          : []),
        ...(status.proposal
          ? [
              `Suggested Change: ${status.proposal.id}  revision ${status.proposal.revision}`,
            ]
          : []),
        ...(status.external?.pull
          ? [
              `GitHub PR #${status.external.pull.number}  ${status.external.pull.head}`,
            ]
          : []),
        ...(status.pending
          ? ["Submission awaiting confirmation; retry barndog push."]
          : []),
        ...status.conflicts.map((path) => `Conflict: ${safe(path)}`),
        ...renderCollaboration("diff", status.changes).filter(
          (line) => !line.startsWith("@@") && !line.startsWith("+"),
        ),
      ];
    }
    if ("root" in value) {
      const result = value as {
        root: string;
        version?: number;
        baseVersion?: number | null;
        commit?: string;
        conflicts?: string[];
      };
      return [
        `Working copy: ${safe(result.root)}`,
        ...(result.commit
          ? [`Base: ${result.commit.slice(0, 7)}`]
          : result.version || result.baseVersion
            ? [`Base: v${result.version ?? result.baseVersion}`]
            : []),
        ...(result.conflicts?.length
          ? result.conflicts.map(
              (path) =>
                `Conflict: ${safe(path)}; edit and run barndog resolve <path>.`,
            )
          : []),
      ];
    }
    if ("resolved" in value) return [`Resolved: ${safe(value.resolved)}`];
  }
  return [safe(JSON.stringify(value, null, 2))];
}
