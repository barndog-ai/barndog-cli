import { homedir } from "node:os";
import {
  knowledgeDocumentSchema,
  knowledgeIndexSchema,
} from "@barndog-ai/api-contract";
import { connection } from "../collaboration/remote.js";
import { request } from "../environment/remote.js";
import { openRepoSource } from "../environment/workspace-source.js";
import { activeLocal, localOverlay } from "../git-workspace/overlay.js";
import { readSettings } from "../../config/settings.js";
import { CliError } from "../../errors.js";

/** Session start must stay fast, so reading knowledge never contacts the Git host. */
async function repoKnowledge(home: string) {
  const settings = await readSettings(home);
  const repo = settings && openRepoSource(settings, home, { refresh: "none" });
  return repo ? (await repo.model()).knowledge : undefined;
}

async function sharedKnowledge(home: string, always: boolean) {
  const local = await repoKnowledge(home);
  if (local)
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
  const conn = await connection(home),
    documents: typeof knowledgeIndexSchema._output.documents = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const params: URLSearchParams = new URLSearchParams({
      limit: "100",
      ...(always ? { accessMode: "always" } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const page: typeof knowledgeIndexSchema._output = await request(
      conn,
      `/v1/knowledge?${params}`,
      knowledgeIndexSchema,
      home,
    );
    documents.push(...page.documents);
    if (page.nextCursor && seen.has(page.nextCursor))
      throw new Error("Invalid knowledge pagination");
    if (page.nextCursor) seen.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
  return documents;
}

async function sharedDocument(name: string, home: string) {
  const local = await repoKnowledge(home);
  if (local) {
    const doc = local.find((d) => d.content.name === name);
    if (!doc)
      throw new CliError(
        `No knowledge document named ${name}.`,
        "barndog knowledge list",
      );
    return { id: doc.id, version: { id: doc.version, content: doc.content } };
  }
  const conn = await connection(home);
  return request(
    conn,
    `/v1/knowledge/${encodeURIComponent(name)}`,
    knowledgeDocumentSchema,
    home,
  );
}

type KnowledgeRow = Awaited<ReturnType<typeof sharedKnowledge>>[number];

async function keptLocal(home: string, shared: KnowledgeRow[]) {
  const settings = await readSettings(home);
  const overlay = settings && localOverlay(settings, home);
  if (!overlay) return [];
  return (
    await activeLocal(
      overlay,
      shared.map((doc) => ({ kind: "knowledge", name: doc.name })),
    )
  ).knowledge;
}

/** Knowledge files that can't be read, so they don't vanish without a word. */
export async function knowledgeProblems(home = homedir()) {
  const settings = await readSettings(home);
  if (!settings) return [];
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

export async function knowledgeList(always = false, home = homedir()) {
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

export async function knowledgeGet(name: string, home = homedir()) {
  try {
    return await sharedDocument(name, home);
  } catch (error) {
    const doc = (await keptLocal(home, [])).find(
      (d) => d.content.name === name,
    );
    if (!doc) throw error;
    return { id: doc.id, version: { id: doc.version, content: doc.content } };
  }
}

export function knowledgeIndexText(
  documents: Awaited<ReturnType<typeof knowledgeList>>,
) {
  if (!documents.length) return "";
  return [
    "Available organization knowledge (retrieve full content with barndog knowledge get <name>):",
    ...documents.map(
      (d) => `- ${d.name}: ${d.description.replace(/[\r\n]+/g, " ")}`,
    ),
  ].join("\n");
}
