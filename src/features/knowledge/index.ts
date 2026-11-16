import type { RuntimeContext } from "../../runtime.js";
import { z } from "zod";
import {
  knowledgeDocumentSchema,
  knowledgeIndexSchema,
  type KnowledgeContent,
} from "@barndog-ai/api-contract";
import { connection } from "../server/connection.js";
import { parsed } from "../server/client.js";
import { openRepoSource } from "../workspace/workspace-source.js";
import { activeLocal, localOverlay } from "../workspace/overlay.js";
import { readSettings } from "../../config/settings.js";
import { CliError } from "../../errors.js";
import type { InvalidKnowledge } from "../workspace/format.js";
import { allPages, PAGE_SIZE } from "../server/pages.js";
import { apiClient } from "../auth/transport.js";

type KnowledgeIndex = z.infer<typeof knowledgeIndexSchema>;

/** A knowledge document's name and description, without its content. */
type KnowledgeSummary = KnowledgeIndex["documents"][number];

export type KnowledgeListing = KnowledgeSummary & {
  /** Whether session start lists it: an `always` document while listing is on. */
  listedAtStart: boolean;
};

/** A document's current content; a repository or local document has no more to say. */
export type KnowledgeDocument = {
  id: string;
  version: { id: string; content: KnowledgeContent };
};

/** Session start must stay fast, so reading knowledge never contacts the Git host. */
async function repoKnowledge(runtime: RuntimeContext) {
  const { home } = runtime;

  const settings = await readSettings(home);
  const repo =
    settings && openRepoSource(settings, runtime, { refresh: "none" });

  return repo ? (await repo.model()).knowledge : undefined;
}

async function sharedKnowledge(
  runtime: RuntimeContext,
  always: boolean,
): Promise<KnowledgeSummary[]> {
  const local = await repoKnowledge(runtime);
  if (local) {
    return local
      .filter((doc) => !always || doc.content.accessMode === "always")
      .map((doc) => ({
        id: doc.id,
        name: doc.content.name,
        description: doc.content.description,
        tags: doc.content.tags,
        accessMode: doc.content.accessMode,
        versionId: doc.version,
        version: 0,
      }));
  }

  const conn = await connection(runtime);

  return allPages(async (cursor) => {
    const page: KnowledgeIndex = await parsed(
      knowledgeIndexSchema,
      apiClient(conn.server, runtime).GET("/v1/knowledge", {
        params: {
          query: {
            limit: PAGE_SIZE,
            cursor,
            ...(always ? { accessMode: "always" as const } : {}),
          },
        },
      }),
    );

    return { items: page.documents, nextCursor: page.nextCursor };
  });
}

async function sharedDocument(
  name: string,
  runtime: RuntimeContext,
): Promise<KnowledgeDocument> {
  const local = await repoKnowledge(runtime);
  if (local) {
    const doc = local.find((d) => d.content.name === name);
    if (!doc) {
      throw new CliError(
        `No knowledge document named ${name}.`,
        "barndog knowledge list",
      );
    }

    return { id: doc.id, version: { id: doc.version, content: doc.content } };
  }

  const conn = await connection(runtime);

  return parsed(
    knowledgeDocumentSchema,
    apiClient(conn.server, runtime).GET("/v1/knowledge/{selector}", {
      params: { path: { selector: name } },
    }),
  );
}

async function keptLocal(runtime: RuntimeContext, shared: KnowledgeSummary[]) {
  const { home } = runtime;

  const settings = await readSettings(home);
  const overlay = settings && localOverlay(settings, runtime);
  if (!overlay) {
    return [];
  }

  return (
    await activeLocal(
      overlay,
      shared.map((doc) => ({ kind: "knowledge", name: doc.name })),
    )
  ).knowledge;
}

/** Knowledge files that can't be read, so they don't vanish without a word. */
export async function knowledgeProblems(
  runtime: RuntimeContext,
): Promise<InvalidKnowledge[]> {
  const { home } = runtime;

  const settings = await readSettings(home);
  if (!settings) {
    return [];
  }

  const sources = [
    openRepoSource(settings, runtime, { refresh: "none" }),
    localOverlay(settings, runtime),
  ].flatMap((source) => (source ? [source] : []));

  const models = await Promise.all(sources.map((source) => source.model()));

  return [
    ...new Map(
      models.flatMap((m) => m.invalidKnowledge).map((p) => [p.path, p]),
    ).values(),
  ];
}

/**
 * Lists shared and retained local knowledge, optionally restricting to always-
 * access documents, and marks session-start visibility.
 */
export async function knowledgeList(
  always = false,
  runtime: RuntimeContext,
): Promise<KnowledgeListing[]> {
  const { home } = runtime;

  const settings = await readSettings(home);
  const listing = settings?.knowledge !== false;
  const shared = await sharedKnowledge(runtime, always);
  const local = (await keptLocal(runtime, shared))
    .filter((doc) => !always || doc.content.accessMode === "always")
    .map((doc) => ({
      id: doc.id,
      name: doc.content.name,
      description: doc.content.description,
      tags: doc.content.tags,
      accessMode: doc.content.accessMode,
      versionId: doc.version,
      version: 0,
    }));

  return [...shared, ...local].map((doc) => ({
    ...doc,
    listedAtStart: listing && doc.accessMode === "always",
  }));
}

/**
 * Retrieves shared knowledge by name, falling back to a retained local document
 * if the shared lookup fails.
 */
export async function knowledgeGet(
  name: string,
  runtime: RuntimeContext,
): Promise<KnowledgeDocument> {
  try {
    return await sharedDocument(name, runtime);
  } catch (error) {
    const doc = (await keptLocal(runtime, [])).find(
      (d) => d.content.name === name,
    );

    if (!doc) {
      throw error;
    }

    return { id: doc.id, version: { id: doc.version, content: doc.content } };
  }
}

/**
 * Formats a newline-separated session-start index with single-line
 * descriptions; no documents produce an empty string.
 */
export function knowledgeIndexText(documents: KnowledgeListing[]) {
  if (!documents.length) {
    return "";
  }

  return [
    "Available organization knowledge (retrieve full content with barndog knowledge get <name>):",
    ...documents.map(
      (d) => `- ${d.name}: ${d.description.replace(/[\r\n]+/g, " ")}`,
    ),
  ].join("\n");
}
