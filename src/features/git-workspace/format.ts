import { MAX_ASSET_NAME_LENGTH } from "../../shared/constants.js";

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
  GIT_MODE,
  type Snapshot,
  type SnapshotEntry,
} from "./snapshot.js";
import { assetKinds } from "../asset-kinds/index.js";
import { defined } from "../../shared/lookup.js";
import { NAME, splitFrontMatter } from "../../shared/patterns.js";

/** BarnDog workspace configuration allows display names up to 200 characters. */
const MAX_WORKSPACE_NAME_LENGTH = 200;

/** RFC 9562 UUIDs contain 128 bits, or sixteen bytes. */
const UUID_BYTE_LENGTH = 16;

/** RFC 9562 places the version nibble in byte six (zero based). */
const UUID_VERSION_BYTE = 6;

/** RFC 9562 preserves the low nibble when setting the UUID version. */
const UUID_VERSION_PAYLOAD_MASK = 0x0f;

/** RFC 9562 version four occupies the high nibble. */
const UUID_V4_BITS = 0x40;

/** RFC 9562 places the variant bits in byte eight (zero based). */
const UUID_VARIANT_BYTE = 8;

/** RFC 9562 preserves six payload bits for the IETF variant. */
const UUID_VARIANT_PAYLOAD_MASK = 0x3f;

/** RFC 9562 IETF variant starts with binary 10. */
const UUID_IETF_VARIANT_BITS = 0x80;

/** RFC 9562 hexadecimal UUID first group ends at character eight. */
const UUID_FIRST_GROUP_END = 8;

/** RFC 9562 hexadecimal UUID third group ends at character sixteen. */
const UUID_THIRD_GROUP_END = 16;

/** RFC 9562 hexadecimal UUID group boundary (8-4-4-4-12). */
const UUID_SECOND_GROUP_END = 12;

/** RFC 9562 hexadecimal UUID fourth group ends at character twenty. */
const UUID_FOURTH_GROUP_END = 20;

/**
 * The file at a Git or local workspace's root naming the workspace and
 * declaring its teams and repositories.
 */
export const CONFIG_FILE = "barndog.yaml";

export const NAME_RULE =
  "Names use lowercase letters, numbers and single hyphens";

const slug = z.string().regex(NAME);

const configSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.uuidv4(),
    name: z.string().trim().min(1).max(MAX_WORKSPACE_NAME_LENGTH),
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

/**
 * The `barndog.yaml` a new workspace starts with: format version 1, its ID and
 * name, and no teams or repositories yet.
 */
function renderConfig(config: Pick<WorkspaceConfig, "workspaceId" | "name">) {
  return stringify({
    version: 1,
    workspaceId: config.workspaceId,
    name: config.name,
    teams: {},
    repositories: {},
    optional: [],
  });
}

/**
 * Parses barndog.yaml and reports schema-invalid fields in a CliError.
 * Malformed YAML can throw a parser error before schema validation.
 */
export function parseConfig(text: string): WorkspaceConfig {
  const parsed = configSchema.safeParse(parse(text));
  if (!parsed.success) {
    throw new CliError(
      `${CONFIG_FILE} is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "file"}: ${issue.message}`).join("; ")}`,
    );
  }

  return parsed.data;
}

/** A hash formatted as UUIDv4, so IDs need no stored record and cannot merge-conflict. */
export function stableId(...parts: string[]) {
  const bytes = createHash("sha256")
    .update(parts.join("\0"))
    .digest()
    .subarray(0, UUID_BYTE_LENGTH);

  // A 16-byte digest always has these bytes; set the UUID version and variant bits.
  bytes.writeUInt8(
    (bytes.readUInt8(UUID_VERSION_BYTE) & UUID_VERSION_PAYLOAD_MASK) |
      UUID_V4_BITS,
    UUID_VERSION_BYTE,
  );

  bytes.writeUInt8(
    (bytes.readUInt8(UUID_VARIANT_BYTE) & UUID_VARIANT_PAYLOAD_MASK) |
      UUID_IETF_VARIANT_BITS,
    UUID_VARIANT_BYTE,
  );

  const hex = bytes.toString("hex");

  return `${hex.slice(0, UUID_FIRST_GROUP_END)}-${hex.slice(UUID_FIRST_GROUP_END, UUID_SECOND_GROUP_END)}-${hex.slice(UUID_SECOND_GROUP_END, UUID_THIRD_GROUP_END)}-${hex.slice(UUID_THIRD_GROUP_END, UUID_FOURTH_GROUP_END)}-${hex.slice(UUID_FOURTH_GROUP_END)}`;
}

/**
 * A scope as a Git or local workspace lays it out: the organization at the
 * root, teams under `teams/<slug>`, repositories under `repos/<slug>`. IDs are
 * hashes formatted as UUIDv4 so they look like Cloud IDs.
 */
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

/**
 * An asset read from a workspace folder. `invalid` says why it can't be
 * installed; it is still listed so the problem shows up.
 */
export type RepoAsset = AssetReference & {
  origin: RepoScope;
  path: string;
  description: string;
  entries: PackageEntry[];
  definition?: McpDefinition;
  invalid?: string;
};

/**
 * A knowledge document read from a workspace folder; `version` is its Git blob
 * hash.
 */
export type RepoKnowledge = {
  id: string;
  version: string;
  path: string;
  content: KnowledgeContent;
};

type Problem = { path: string; reason: string };

/**
 * Everything a Git or local workspace holds at one commit, with the same
 * catalog shape Cloud returns, plus what couldn't be read.
 */
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
  invalidKnowledge: readonly InvalidKnowledge[];
  problems: Problem[];
};

/** A knowledge file that couldn't be read, and why. */
export type InvalidKnowledge = { path: string; reason: string };

const hidden = (name: string) => name.startsWith(".");

function frontMatter(text: string) {
  const parts = splitFrontMatter(text);
  if (!parts) {
    throw new Error("Missing front matter");
  }

  return { metadata: parse(parts.yaml) as unknown, body: parts.body };
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

  if (fields.name !== undefined && fields.name !== name) {
    throw new Error(`name must match the file name (${name})`);
  }

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
  if (!configEntry || !isBlob(configEntry.mode)) {
    throw new CliError(
      `This isn't a BarnDog workspace: it has no ${CONFIG_FILE}.`,
    );
  }

  const blobs = await snapshot.readBlobs(
    snapshot.entries
      .filter((entry) => isBlob(entry.mode))
      .map((entry) => entry.hash),
  );

  const blob = (entry: SnapshotEntry) =>
    defined(blobs.get(entry.hash), `Git object ${entry.hash} wasn't read`);

  const text = (entry: SnapshotEntry) => blob(entry).toString("utf8");
  const config = parseConfig(text(configEntry));
  if (expectedId && config.workspaceId !== expectedId) {
    throw new CliError(
      `${CONFIG_FILE} now names a different workspace. Run setup again if this is intended.`,
      "barndog init",
    );
  }

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
      .filter(({ entry }) => entry.mode === GIT_MODE.tree)
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
  ] as const) {
    for (const name of [
      ...new Set([...Object.keys(declared), ...folders(root)]),
    ].sort()) {
      scopes.push({
        type,
        id: id("scope", type, name),
        slug: name,
        name: declared[name]?.name ?? name,
        canPublish: true,
        path: `${root}/${name}`,
      });
    }
  }

  const problems: Problem[] = [];
  const assets: RepoAsset[] = [];
  const knowledge: RepoKnowledge[] = [];
  const invalidKnowledge: InvalidKnowledge[] = [];
  const named = (path: string, name: string) => {
    if (validAssetName(name)) {
      return true;
    }

    problems.push({ path, reason: NAME_RULE });

    return false;
  };

  function packageEntries(root: string) {
    const entries: PackageEntry[] = [];
    for (const entry of snapshot.entries) {
      if (!entry.path.startsWith(`${root}/`) || entry.mode === GIT_MODE.tree) {
        continue;
      }

      if (!isBlob(entry.mode)) {
        throw new Error(
          `UNSAFE_PACKAGE_ENTRY: ${entry.path.slice(root.length + 1)} is a link`,
        );
      }

      entries.push({
        path: entry.path.slice(root.length + 1),
        data: blob(entry),
        executable: entry.mode === GIT_MODE.executable,
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
      if (entry.mode !== GIT_MODE.tree || !named(entry.path, name)) {
        continue;
      }

      add("skill", name, entry, () => {
        const entries = validatePackageEntries(packageEntries(entry.path));
        const metadata = packageMetadata(entries);
        if (metadata.name !== name) {
          throw new Error(`SKILL.md name must match the folder name (${name})`);
        }

        return { description: metadata.description, entries };
      });
    }

    for (const { entry, name } of under(`${scope.path}/hooks`)) {
      if (entry.mode !== GIT_MODE.tree || !named(entry.path, name)) {
        continue;
      }

      add("hook", name, entry, () => {
        const entries = validatePackageEntries(
          packageEntries(entry.path),
          undefined,
          "hook.yaml",
        );

        const manifest = hookMetadata(entries);
        if (manifest.name !== name) {
          throw new Error(
            `hook.yaml name must match the folder name (${name})`,
          );
        }

        return { description: manifest.description, entries };
      });
    }

    for (const { entry, name: file } of under(`${scope.path}/mcp`)) {
      if (!isBlob(entry.mode) || !/\.ya?ml$/.test(file)) {
        continue;
      }

      const name = file.replace(/\.ya?ml$/, "");
      if (!named(entry.path, name)) {
        continue;
      }

      add("mcp", name, entry, () => {
        const definition = mcpDefinitionSchema.parse(parse(text(entry)));

        return { description: definition.description, entries: [], definition };
      });
    }

    if (scope.type !== "org") {
      if (under(`${scope.path}/knowledge`).length) {
        problems.push({
          path: `${scope.path}/knowledge`,
          reason: "Knowledge is organization-wide; move it to org/knowledge",
        });
      }

      continue;
    }

    for (const { entry, name: file } of under(`${scope.path}/knowledge`)) {
      if (!isBlob(entry.mode) || !file.endsWith(".md")) {
        continue;
      }

      const name = file.replace(/\.md$/, "");
      if (!named(entry.path, name)) {
        continue;
      }

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
  for (const path of optional) {
    if (
      !assets.some(
        (asset) => asset.path === path || asset.path === `${path}.yaml`,
      )
    ) {
      problems.push({
        path: CONFIG_FILE,
        reason: `optional names a missing asset: ${path}`,
      });
    }
  }

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

/**
 * Whether `name` can be an asset's folder and installed name: the name pattern,
 * at most 64 characters.
 */
export function validAssetName(name: string) {
  return slug.safeParse(name).success && name.length <= MAX_ASSET_NAME_LENGTH;
}

/** Names become folder and file names, so check them before touching the disk. */
export function assertAssetName(name: string, fix: string) {
  if (!validAssetName(name)) {
    throw new CliError(`${name} can't be used as a name. ${NAME_RULE}.`, fix);
  }
}

/** Where a new asset belongs inside a scope: a folder per package, a file per MCP server. */
export function assetPath(scopePath: string, kind: AssetKind, name: string) {
  const folder = `${scopePath}/${assetKinds[kind].folder}`;
  if (kind === "mcp") {
    return `${folder}/${name}.yaml`;
  }

  return `${folder}/${name}`;
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
