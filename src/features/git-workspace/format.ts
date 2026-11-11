import { createHash } from "node:crypto";

import {
  knowledgeContentSchema,
  mcpDefinitionSchema,
  type KnowledgeContent,
  type McpDefinition,
} from "@barndog-ai/api-contract";
import {
  hookMetadata,
  packageMetadata,
  validatePackageEntries,
  type PackageEntry,
} from "@barndog-ai/api-contract/package";
import { parse, stringify } from "yaml";
import { z } from "zod";

import { CliError, friendlyMessage } from "../../errors.js";
import type { AssetKind, AssetReference } from "../asset-selection/types.js";
import {
  isBlob,
  TREE_MODE,
  type Snapshot,
  type SnapshotEntry,
} from "./snapshot.js";

export const CONFIG_FILE = "barndog.yaml";

export const NAME_RULE =
  "Names use lowercase letters, numbers and single hyphens";

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const configSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.uuidv4(),
    name: z.string().trim().min(1).max(200),
    teams: z
      .record(slug, z.object({ name: z.string().min(1) }).strict())
      .default({}),
    repositories: z
      .record(
        slug,
        z
          .object({
            name: z.string().min(1).optional(),
            gitRemote: z.string().min(1).optional(),
            team: slug.optional(),
          })
          .strict(),
      )
      .default({}),
    optional: z.array(z.string()).default([]),
  })
  .strict();

export type WorkspaceConfig = z.infer<typeof configSchema>;

export function renderConfig(
  config: Pick<WorkspaceConfig, "workspaceId" | "name">,
) {
  return stringify({
    version: 1,
    workspaceId: config.workspaceId,
    name: config.name,
    teams: {},
    repositories: {},
    optional: [],
  });
}

export function parseConfig(text: string): WorkspaceConfig {
  const parsed = configSchema.safeParse(parse(text));
  if (!parsed.success)
    throw new CliError(
      `${CONFIG_FILE} is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "file"}: ${issue.message}`).join("; ")}`,
    );
  return parsed.data;
}

/** A hash formatted as UUIDv4, so IDs need no stored record and cannot merge-conflict. */
export function stableId(...parts: string[]) {
  const bytes = createHash("sha256")
    .update(parts.join("\0"))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type RepoScope = {
  type: "org" | "team" | "repo";
  id: string;
  slug: string;
  name: string;
  canPublish: boolean;
  /** The folder holding this scope's assets. */
  path: string;
  /** This machine's own folder, which belongs to no organization. */
  localOnly?: true;
};

export type RepoAsset = AssetReference & {
  origin: RepoScope;
  path: string;
  description: string;
  entries: PackageEntry[];
  definition?: McpDefinition;
  invalid?: string;
};

export type RepoKnowledge = {
  id: string;
  version: string;
  path: string;
  content: KnowledgeContent;
};

export type Problem = { path: string; reason: string };

export type WorkspaceModel = {
  config: WorkspaceConfig;
  organizationId: string;
  scopes: RepoScope[];
  assets: RepoAsset[];
  knowledge: RepoKnowledge[];
  catalog: {
    assets: RepoAsset[];
    distributions: {
      scope: { type: "org" | "team" | "repo"; id: string };
      assets: { assetId: string; mode: "recommended" | "optional" }[];
    }[];
  };
  invalid: ReadonlyMap<string, string>;
  invalidKnowledge: readonly { path: string; reason: string }[];
  problems: Problem[];
};

const hidden = (name: string) => name.startsWith(".");

function frontMatter(text: string) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error("Missing front matter");
  return {
    metadata: parse(match[1]!) as unknown,
    body: text.slice(match[0].length),
  };
}

function knowledgeContent(name: string, text: string): KnowledgeContent {
  const { metadata, body } = frontMatter(text);
  const fields = z
    .object({
      name: z.string().optional(),
      description: z.string(),
      tags: z.array(z.string()).default([]),
      accessMode: z.enum(["always", "on-demand"]).default("on-demand"),
    })
    .strict()
    .parse(metadata);
  if (fields.name !== undefined && fields.name !== name)
    throw new Error(`name must match the file name (${name})`);
  return knowledgeContentSchema.parse({ ...fields, name, markdown: body });
}

/** Turns a snapshot into the same catalog cloud returns, reporting what cannot install. */
export async function loadWorkspace(
  snapshot: Snapshot,
  expectedId?: string,
  options: { localOnly?: boolean } = {},
): Promise<WorkspaceModel> {
  const byPath = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
  const configEntry = byPath.get(CONFIG_FILE);
  if (!configEntry || !isBlob(configEntry.mode))
    throw new CliError(
      `This isn't a BarnDog workspace: it has no ${CONFIG_FILE}.`,
    );
  const blobs = await snapshot.readBlobs(
    snapshot.entries
      .filter((entry) => isBlob(entry.mode))
      .map((entry) => entry.hash),
  );
  const text = (entry: SnapshotEntry) =>
    blobs.get(entry.hash)!.toString("utf8");
  const config = parseConfig(text(configEntry));
  if (expectedId && config.workspaceId !== expectedId)
    throw new CliError(
      `${CONFIG_FILE} now names a different workspace. Run setup again if this is intended.`,
      "barndog init",
    );
  const id = (...parts: string[]) => stableId(config.workspaceId, ...parts);
  const children = new Map<string, SnapshotEntry[]>();
  for (const entry of snapshot.entries) {
    const parent = entry.path.includes("/")
      ? entry.path.slice(0, entry.path.lastIndexOf("/"))
      : "";
    children.set(parent, [...(children.get(parent) ?? []), entry]);
  }
  const under = (path: string) =>
    (children.get(path) ?? [])
      .map((entry) => ({ entry, name: entry.path.slice(path.length + 1) }))
      .filter(({ name }) => !hidden(name))
      .sort((a, b) => a.name.localeCompare(b.name));
  const folders = (path: string) =>
    under(path)
      .filter(({ entry }) => entry.mode === TREE_MODE)
      .map(({ name }) => name);

  const organizationId = id("scope", "org");
  const scopes: RepoScope[] = [
    {
      type: "org",
      id: organizationId,
      slug: "org",
      name: config.name,
      canPublish: true,
      path: "org",
      ...(options.localOnly ? { localOnly: true as const } : {}),
    },
  ];
  for (const [type, root, declared] of [
    ["team", "teams", config.teams],
    ["repo", "repos", config.repositories],
  ] as const)
    for (const name of [
      ...new Set([...Object.keys(declared), ...folders(root)]),
    ].sort())
      scopes.push({
        type,
        id: id("scope", type, name),
        slug: name,
        name: declared[name]?.name ?? name,
        canPublish: true,
        path: `${root}/${name}`,
      });

  const problems: Problem[] = [];
  const assets: RepoAsset[] = [];
  const knowledge: RepoKnowledge[] = [];
  const invalidKnowledge: { path: string; reason: string }[] = [];
  const named = (path: string, name: string) => {
    if (validAssetName(name)) return true;
    problems.push({ path, reason: NAME_RULE });
    return false;
  };

  function packageEntries(root: string) {
    const entries: PackageEntry[] = [];
    for (const entry of snapshot.entries) {
      if (!entry.path.startsWith(`${root}/`) || entry.mode === TREE_MODE)
        continue;
      if (!isBlob(entry.mode))
        throw new Error(
          `UNSAFE_PACKAGE_ENTRY: ${entry.path.slice(root.length + 1)} is a link`,
        );
      entries.push({
        path: entry.path.slice(root.length + 1),
        data: blobs.get(entry.hash)!,
        executable: entry.mode === "100755",
      });
    }
    return entries;
  }

  for (const scope of scopes) {
    const add = (
      kind: AssetKind,
      name: string,
      entry: SnapshotEntry,
      read: () => Pick<RepoAsset, "description" | "entries" | "definition">,
    ) => {
      const base = {
        kind,
        id: id("asset", kind, scope.type, scope.slug, name),
        name,
        origin: scope,
        publishedVersion: entry.hash,
        path: entry.path,
      };
      try {
        assets.push({ ...base, ...read() });
      } catch (error) {
        const reason = friendlyMessage(error);
        problems.push({ path: entry.path, reason });
        assets.push({ ...base, description: "", entries: [], invalid: reason });
      }
    };
    for (const { entry, name } of under(`${scope.path}/skills`)) {
      if (entry.mode !== TREE_MODE || !named(entry.path, name)) continue;
      add("skill", name, entry, () => {
        const entries = validatePackageEntries(packageEntries(entry.path));
        const metadata = packageMetadata(entries);
        if (metadata.name !== name)
          throw new Error(`SKILL.md name must match the folder name (${name})`);
        return { description: metadata.description, entries };
      });
    }
    for (const { entry, name } of under(`${scope.path}/hooks`)) {
      if (entry.mode !== TREE_MODE || !named(entry.path, name)) continue;
      add("hook", name, entry, () => {
        const entries = validatePackageEntries(
          packageEntries(entry.path),
          undefined,
          "hook.yaml",
        );
        const manifest = hookMetadata(entries);
        if (manifest.name !== name)
          throw new Error(
            `hook.yaml name must match the folder name (${name})`,
          );
        return { description: manifest.description, entries };
      });
    }
    for (const { entry, name: file } of under(`${scope.path}/mcp`)) {
      if (!isBlob(entry.mode) || !/\.ya?ml$/.test(file)) continue;
      const name = file.replace(/\.ya?ml$/, "");
      if (!named(entry.path, name)) continue;
      add("mcp", name, entry, () => {
        const definition = mcpDefinitionSchema.parse(parse(text(entry)));
        return { description: definition.description, entries: [], definition };
      });
    }
    if (scope.type !== "org") {
      if (under(`${scope.path}/knowledge`).length)
        problems.push({
          path: `${scope.path}/knowledge`,
          reason: "Knowledge is organization-wide; move it to org/knowledge",
        });
      continue;
    }
    for (const { entry, name: file } of under(`${scope.path}/knowledge`)) {
      if (!isBlob(entry.mode) || !file.endsWith(".md")) continue;
      const name = file.replace(/\.md$/, "");
      if (!named(entry.path, name)) continue;
      try {
        knowledge.push({
          id: id("knowledge", name),
          version: entry.hash,
          path: entry.path,
          content: knowledgeContent(name, text(entry)),
        });
      } catch (error) {
        const problem = { path: entry.path, reason: friendlyMessage(error) };
        problems.push(problem);
        invalidKnowledge.push(problem);
      }
    }
  }

  const optional = new Set(config.optional);
  for (const path of optional)
    if (
      !assets.some(
        (asset) => asset.path === path || asset.path === `${path}.yaml`,
      )
    )
      problems.push({
        path: CONFIG_FILE,
        reason: `optional names a missing asset: ${path}`,
      });
  const distributions = scopes.map((scope) => ({
    scope: { type: scope.type, id: scope.id },
    assets: assets
      .filter((asset) => asset.origin.id === scope.id)
      .map((asset) => ({
        assetId: asset.id,
        mode:
          optional.has(asset.path) ||
          optional.has(asset.path.replace(/\.ya?ml$/, ""))
            ? ("optional" as const)
            : ("recommended" as const),
      })),
  }));
  return {
    config,
    organizationId,
    scopes,
    assets,
    knowledge,
    invalidKnowledge,
    catalog: { assets, distributions },
    invalid: new Map(
      assets.flatMap((asset) =>
        asset.invalid ? [[asset.id, asset.invalid]] : [],
      ),
    ),
    problems,
  };
}

export function validAssetName(name: string) {
  return slug.safeParse(name).success && name.length <= 64;
}

/** Names become folder and file names, so check them before touching the disk. */
export function assertAssetName(name: string, fix: string) {
  if (!validAssetName(name))
    throw new CliError(`${name} can't be used as a name. ${NAME_RULE}.`, fix);
}

/** Where a new asset of this kind belongs inside a scope. */
export function assetFolder(
  scopePath: string,
  kind: "skill" | "hook",
  name: string,
) {
  return `${scopePath}/${kind === "skill" ? "skills" : "hooks"}/${name}`;
}

const WELCOME = `# BarnDog workspace

Shared Skills, knowledge, MCP configurations and Hooks for this team.
Set up a machine with \`barndog init --repo <this repository's URL>\`.

## Keeping this repository safe

Anything merged to the default branch installs on every machine that selected it,
including Hooks and MCP servers that run code. BarnDog installs them without asking.
Keeping this repository safe is the job of its maintainers and members: protect the
default branch and review every change. Anyone who can read this repository can read
all of it, including other teams' folders.
`;

/** The files a brand-new workspace starts with. */
export function skeleton(
  config: Pick<WorkspaceConfig, "workspaceId" | "name">,
) {
  return [
    { path: CONFIG_FILE, data: Buffer.from(renderConfig(config)) },
    { path: "README.md", data: Buffer.from(WELCOME) },
    ...["skills", "knowledge", "mcp", "hooks"].map((folder) => ({
      path: `org/${folder}/.gitkeep`,
      data: Buffer.alloc(0),
    })),
  ];
}
