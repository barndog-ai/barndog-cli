import { homedir } from "node:os";
import { z } from "zod";
import {
  knowledgeDocumentSchema,
  knowledgeIndexSchema,
  type KnowledgeContent,
} from "@barndog-ai/api-contract";
import { connection } from "../server/connection.js";
import { request } from "../server/request.js";
import { openRepoSource } from "../environment/workspace-source.js";
import { activeLocal, localOverlay } from "../git-workspace/overlay.js";
import { readSettings } from "../../config/settings.js";
import { CliError } from "../../errors.js";
import type { InvalidKnowledge } from "../git-workspace/format.js";
import { allPages } from "../server/pages.js";

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
async function repoKnowledge(home: string) {
  const settings = await readSettings(home);
  const repo = settings && openRepoSource(settings, home, { refresh: "none" });

  return repo ? (await repo.model()).knowledge : undefined;
}

async function sharedKnowledge(
  home: string,
  always: boolean,
): Promise<KnowledgeSummary[]> {
  const local = await repoKnowledge(home);
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

  const conn = await connection(home);

  return allPages(async (cursor) => {
    const params = new URLSearchParams({
      limit: "100",
      ...(always ? { accessMode: "always" } : {}),
      ...(cursor ? { cursor } : {}),
    });

    const page: KnowledgeIndex = await request(
      conn,
      `/v1/knowledge?${params}`,
      knowledgeIndexSchema,
      { home },
    );

    return { items: page.documents, nextCursor: page.nextCursor };
  });
}

async function sharedDocument(
  name: string,
  home: string,
): Promise<KnowledgeDocument> {
  const local = await repoKnowledge(home);
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

  const conn = await connection(home);

  return request(
    conn,
    `/v1/knowledge/${encodeURIComponent(name)}`,
    knowledgeDocumentSchema,
    { home },
  );
}

async function keptLocal(home: string, shared: KnowledgeSummary[]) {
  const settings = await readSettings(home);
  const overlay = settings && localOverlay(settings, home);
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
  home = homedir(),
): Promise<InvalidKnowledge[]> {
  const settings = await readSettings(home);
  if (!settings) {
    return [];
  }

  const sources = [
    openRepoSource(settings, home, { refresh: "none" }),
    localOverlay(settings, home),
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
  home = homedir(),
): Promise<KnowledgeListing[]> {
  const settings = await readSettings(home);
  const listing = settings?.knowledge !== false;
  const shared = await sharedKnowledge(home, always);
  const local = (await keptLocal(home, shared))
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
  home = homedir(),
): Promise<KnowledgeDocument> {
  try {
    return await sharedDocument(name, home);
  } catch (error) {
    const doc = (await keptLocal(home, [])).find(
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
