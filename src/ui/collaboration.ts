import { primary } from "./theme.js";
import { renderSyncOutput } from "./output.js";
import { changeSchema } from "@barndog-ai/api-contract";
import { textContent } from "@barndog-ai/api-contract/collaboration";
import { z } from "zod";
import type { EnvironmentPreview } from "../features/collaboration/index.js";
import { isRecord } from "../shared/values.js";

/** C0 and C1 control characters other than tab and line feed, such as ESC (`\x1b`). */
// eslint-disable-next-line no-control-regex -- finding control characters is the point
const CONTROL_CHARACTERS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * Remote package text must not be able to emit terminal control sequences:
 * `"\x1b[31mred"` → `"\\u001b[31mred"`.
 */
export function safe(value: unknown) {
  return String(value).replace(
    CONTROL_CHARACTERS,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

// The shapes below list only what this module prints; other fields pass through.
const filesSchema = z.array(
  z.looseObject({
    path: z.string(),
    content: z.string(),
    executable: z.boolean().optional(),
  }),
);

const detailsSchema = z.looseObject({
  names: z.record(z.string(), z.string()).optional(),
  baseVersionNumber: z.number().optional(),
});

const pushedSchema = z.looseObject({
  branch: z.string(),
  commit: z.string(),
  published: z.boolean().optional(),
  url: z.string().nullish(),
  opened: z.boolean().optional(),
});

const statusSchema = z.looseObject({
  root: z.string(),
  name: z.string(),
  baseVersion: z.number().nullable(),
  baseCommit: z.string().optional(),
  review: z
    .looseObject({ branch: z.string(), url: z.string().nullable() })
    .nullish(),
  proposal: z.looseObject({ id: z.string(), revision: z.number() }).nullable(),
  external: z
    .looseObject({
      pull: z.looseObject({ number: z.number(), head: z.string() }).nullable(),
    })
    .nullish(),
  conflicts: z.array(z.string()),
  pending: z.boolean(),
  changes: z.array(z.unknown()),
});

const workingCopySchema = z.looseObject({
  root: z.string(),
  version: z.number().optional(),
  baseVersion: z.number().nullish(),
  commit: z.string().optional(),
  conflicts: z.array(z.string()).optional(),
});

const isEnvironmentPreview = (value: unknown): value is EnvironmentPreview =>
  isRecord(value) &&
  value.mode === "environment-preview" &&
  Array.isArray(value.events);

/** A short commit hash, else `v<version>`, else nothing. */
function baseLabel(
  commit: string | null | undefined,
  version: number | null | undefined,
) {
  if (commit) {
    return commit.slice(0, 7);
  }

  return version ? `v${version}` : undefined;
}

function files(value: unknown): string[] {
  const parsed = filesSchema.safeParse(value);
  if (!parsed.success) {
    return [];
  }

  return parsed.data.flatMap((file) => {
    const text = textContent(Buffer.from(file.content, "base64"));

    return [
      primary(`${safe(file.path)}${file.executable ? " (executable)" : ""}`),
      text === null ? "Binary file" : safe(text),
    ];
  });
}

/** Mode changes are worth a mention; a new file having no old mode isn't. */
function executableNote(previous: unknown, next: unknown) {
  if (previous === next || next === null || next === undefined) {
    return "";
  }

  if (previous === null || previous === undefined) {
    return next ? "  executable" : "";
  }

  return `  executable: ${safe(previous)} → ${safe(next)}`;
}

/** Results are told apart by their shape, not by the command that produced them. */
export function renderCollaboration(
  value: unknown,
  options: { details?: boolean } = {},
): string[] {
  if (Array.isArray(value)) {
    if (!value.length) {
      return ["No changes."];
    }

    return value.flatMap((row: unknown) => {
      if (!isRecord(row)) {
        return [safe(JSON.stringify(row, null, 2))];
      }

      if ("patch" in row) {
        return [
          `${safe(row.kind)}  ${safe(row.path)}${row.binary ? " (binary)" : ""}${executableNote(row.oldExecutable, row.newExecutable)}`,
          safe(row.patch),
        ].filter(Boolean);
      }

      if ("status" in row) {
        return [
          `${safe(row.name)}  ${safe(row.status)}  revision ${safe(row.revision)}\n  ${safe(row.id)}  ${safe(row.title)}`,
        ];
      }

      if ("number" in row) {
        return [
          `v${safe(row.number)}  ${safe(row.commit)}\n  ${safe(row.description)}  published by ${safe(row.publisherName ?? row.publishedBy)}`,
        ];
      }

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

    if (options.details) {
      const shown = detailsSchema.safeParse(value);
      const details = shown.success ? shown.data : {};
      const person = (id: string) => safe(details.names?.[id] ?? id);
      rows.push(
        `Author: ${person(change.authorId)}`,
        `Base: ${details.baseVersionNumber ? `v${details.baseVersionNumber}` : (change.baseVersionId ?? "new package")}`,
      );

      for (const review of change.reviews) {
        rows.push(
          `Review: ${review.decision}  revision ${review.revision}  ${person(review.developerId)}`,
        );
      }

      for (const thread of change.threads) {
        rows.push(
          `\nDiscussion ${thread.id}  revision ${thread.revision}${thread.outdated ? " (outdated)" : ""}${thread.resolved ? " (resolved)" : ""}${thread.path ? `  ${safe(thread.path)}:${thread.startLine}-${thread.endLine} (${thread.side})` : ""}`,
        );

        for (const comment of thread.comments) {
          rows.push(`  ${person(comment.authorId)}: ${safe(comment.body)}`);
        }

        if (thread.replacement !== null) {
          rows.push("  Suggested replacement:", safe(thread.replacement));
        }
      }

      if (value && typeof value === "object" && "files" in value) {
        rows.push("", ...files(value.files));
      }
    }

    return rows;
  }

  if (value && typeof value === "object") {
    if (isEnvironmentPreview(value)) {
      return renderSyncOutput(value.events, {
        title: "preview",
        preview: true,
      });
    }

    if ("files" in value) {
      return files(value.files);
    }

    if ("unchanged" in value) {
      return ["Package unchanged."];
    }

    const pushedResult = pushedSchema.safeParse(value);
    if (pushedResult.success) {
      const pushed = pushedResult.data;
      if (pushed.published) {
        return [primary(`Pushed to ${safe(pushed.branch)}`), pushed.commit];
      }

      return [
        primary(`Pushed ${safe(pushed.branch)}`),
        pushed.url
          ? `${pushed.opened ? "Pull request" : "Open the pull request"}: ${safe(pushed.url)}`
          : "Open a pull request from this branch on your Git host.",
      ];
    }

    const statusResult = statusSchema.safeParse(value);
    if (statusResult.success) {
      const status = statusResult.data;

      return [
        primary(`${safe(status.name)}  ${safe(status.root)}`),
        `Base: ${baseLabel(status.baseCommit, status.baseVersion) ?? "new package"}`,
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
        ...renderCollaboration(status.changes).filter(
          (line) => !line.startsWith("@@") && !line.startsWith("+"),
        ),
      ];
    }

    const workingCopy = workingCopySchema.safeParse(value);
    if (workingCopy.success) {
      const result = workingCopy.data;
      const base = baseLabel(
        result.commit,
        result.version || result.baseVersion,
      );

      return [
        `Working copy: ${safe(result.root)}`,
        ...(base ? [`Base: ${base}`] : []),
        ...(result.conflicts?.length
          ? result.conflicts.map(
              (path) =>
                `Conflict: ${safe(path)}; edit and run barndog resolve <path>.`,
            )
          : []),
      ];
    }

    if ("resolved" in value) {
      return [`Resolved: ${safe(value.resolved)}`];
    }
  }

  return [safe(JSON.stringify(value, null, 2))];
}
