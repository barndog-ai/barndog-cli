import { hasRemoteSelections } from "../../config/environment.js";
import { normalizeServer, serverFetch } from "../auth/transport.js";
import {
  contextSchema,
  listOutputSchema,
  createApiClient,
  type Skill,
} from "@barndog-ai/api-contract";
import {
  directoryFingerprint,
  packageFingerprint,
  parsePackage,
  packageMetadata,
  writePackage,
  defaultLimits,
} from "@barndog-ai/api-contract/package";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  readSettings,
  saveSettings,
  upgradeSettings,
  SetupRequiredError,
  type Connection,
  type Settings,
  type SkillSelection,
} from "../../config/settings.js";
import { resolveAssets } from "../asset-selection/index.js";
import type { CatalogAsset } from "../catalog/index.js";
import { errorCode } from "../../errors.js";
import { defined } from "../../shared/lookup.js";
import { GIT_OBJECT_ID } from "../../shared/patterns.js";
import { z } from "zod";

export { normalizeServer } from "../auth/transport.js";

export function apiClient(server: string, home = homedir()) {
  return createApiClient({
    baseUrl: normalizeServer(server),
    fetch: serverFetch(server, home),
  });
}

export async function connectionContext(
  server: string,
  home = homedir(),
): Promise<Connection> {
  server = normalizeServer(server);
  const context = contextSchema.parse(
    (await apiClient(server, home).GET("/v1/context")).data,
  );
  return {
    server,
    organizationId: context.organization.id,
    developerId: context.developer.id,
  };
}

export async function connect(server: string, home = homedir()) {
  const connection = await connectionContext(server, home);
  const settings = await readSettings(home);
  if (!settings) throw new SetupRequiredError();
  const next = upgradeSettings(settings);
  if (
    hasRemoteSelections(next) &&
    next.connection &&
    (next.connection.server !== connection.server ||
      next.connection.organizationId !== connection.organizationId ||
      next.connection.developerId !== connection.developerId)
  )
    throw new Error(
      "Remove API selections before switching server, organization, or developer",
    );
  await saveSettings({ ...next, connection }, home);
}

export async function catalog(
  connection: Connection,
  home = homedir(),
): Promise<Skill[]> {
  const client = apiClient(connection.server, home);
  const context = contextSchema.parse((await client.GET("/v1/context")).data);
  if (
    context.organization.id !== connection.organizationId ||
    context.developer.id !== connection.developerId
  )
    throw new Error(
      "Server organization or developer changed; run initialization again",
    );
  const skills: Skill[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = listOutputSchema.parse(
      (
        await client.GET("/v1/skills", {
          params: { query: { cursor, limit: 100 } },
        })
      ).data,
    );
    if (
      page.skills.some(
        (skill) => skill.organizationId !== connection.organizationId,
      )
    )
      throw new Error("Invalid catalog organization");
    skills.push(...page.skills);
    if (page.nextCursor && cursors.has(page.nextCursor))
      throw new Error("Invalid catalog pagination");
    if (page.nextCursor) cursors.add(page.nextCursor);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  if (new Set(skills.map((skill) => skill.id)).size !== skills.length)
    throw new Error("Duplicate catalog Skill");
  return skills;
}

export async function skillCatalog(
  connection: Connection,
  home: string,
): Promise<CatalogAsset[]> {
  return (await catalog(connection, home)).map((skill) => ({
    id: skill.id,
    kind: "skill",
    name: skill.name,
    origin: skill.origin,
    version: {
      number: skill.version.number,
      description: skill.version.description,
    },
  }));
}

export async function listSkills(home = homedir()) {
  const settings = await readSettings(home);
  if (!settings || settings.version !== 2 || !settings.connection)
    throw new Error("Connect with barndog init --server <url> first");
  return catalog(settings.connection, home);
}

async function fingerprintMatches(root: string, name: string) {
  const saved = z
    .object({ fingerprint: z.string() })
    .parse(JSON.parse(await readFile(join(root, "manifest.json"), "utf8")));
  if ((await directoryFingerprint(join(root, name))) !== saved.fingerprint)
    throw new Error(`Cached Skill was modified locally: ${name}`);
}

async function download(
  skill: Skill,
  connection: Connection,
  home: string,
): Promise<string> {
  const serverKey = createHash("sha256")
    .update(connection.server)
    .digest("hex");
  const root = join(
    home,
    ".barndog",
    "packages",
    serverKey,
    connection.organizationId,
    connection.developerId,
    skill.id,
  );
  await mkdir(root, { recursive: true });
  // Verify previous cached versions too: a new publication must not silently hide local edits.
  for (const commit of await readdir(root)) {
    if (GIT_OBJECT_ID.test(commit))
      await fingerprintMatches(join(root, commit), skill.name);
  }
  const target = join(root, skill.version.commit);
  try {
    await lstat(target);
    await fingerprintMatches(target, skill.name);
    return join(target, skill.name);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const response = await serverFetch(connection.server, home)(
    `${connection.server}/v1/skills/${skill.id}/versions/${skill.version.number}/package`,
    { signal: AbortSignal.timeout(30000) },
  );
  if (!response.ok)
    throw new Error(
      `Package download failed (${response.status}): ${skill.name}`,
    );
  if (Number(response.headers.get("content-length")) > defaultLimits.compressed)
    throw new Error("Package download too large");
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!response.body) throw new Error("Missing package body");
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > defaultLimits.compressed) {
      throw new Error("Package download too large");
    }
    chunks.push(chunk);
  }
  const entries = await parsePackage(Buffer.concat(chunks));
  if (packageMetadata(entries).name !== skill.name)
    throw new Error("Package name does not match catalog");
  if (response.headers.get("etag") !== `"${skill.version.commit}"`)
    throw new Error("Package revision does not match catalog");
  const stage = join(root, `.stage-${randomUUID()}`);
  try {
    await writePackage(join(stage, skill.name), entries);
    await writeFile(
      join(stage, "manifest.json"),
      JSON.stringify({ fingerprint: packageFingerprint(entries) }),
    );
    try {
      await rename(stage, target);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(errorCode(error) ?? ""))
        throw error;
      await fingerprintMatches(target, skill.name);
    }
    return join(target, skill.name);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function prepareSources(
  settings: Settings,
  home: string,
): Promise<SkillSelection[]> {
  if (settings.version === 1) return settings.skills;
  const remote = settings.skills.filter((skill) => skill.kind === "api");
  const result: SkillSelection[] = settings.skills.filter(
    (skill) => skill.kind === "local",
  );
  if (!remote.length) return result;
  const { connection } = settings;
  if (!connection)
    throw new Error(
      "Invalid user settings: API selections require a connection",
    );
  const skills = await catalog(connection, home);
  const resolved = resolveAssets(
    {
      assets: skills.map((skill) => ({
        kind: "skill",
        id: skill.id,
        name: skill.name,
        origin: skill.origin,
        publishedVersion: skill.version.id,
      })),
      distributions: [],
    },
    {
      subscriptions: [],
      individualAssetIds: remote.map((skill) => skill.id),
      disabledAssetIds: remote
        .filter((skill) => !skill.enabled)
        .map((skill) => skill.id),
      excludedAssetIds: [],
    },
  );
  if (resolved.diagnostics.length)
    throw new Error(
      "Selected Skill is missing from the server; installation was preserved",
    );
  for (const effective of resolved.assets) {
    const skill = defined(
      skills.find((skill) => skill.id === effective.asset.id),
      "Selected Skill is missing from the server; installation was preserved",
    );
    result.push({
      id: skill.id,
      enabled: effective.enabled,
      source: effective.enabled
        ? await download(skill, connection, home)
        : "unused-disabled-api-source",
    });
  }
  return result;
}
