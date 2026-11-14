import {
  hookManifestSchema,
  hookSchema,
  mcpSchema,
  skillSchema,
  type Skill,
} from "@barndog-ai/api-contract";
import {
  packageMetadata,
  type PackageEntry,
} from "@barndog-ai/api-contract/package";
import { parse } from "yaml";
import type { z, ZodType } from "zod";
import {
  assetFolders,
  type AssetKind,
  type PackageKind,
} from "../../config/selection.js";
import { CliError, PackageError } from "../../errors.js";

/** A Hook as the server describes it. */
export type Hook = z.infer<typeof hookSchema>;

/** An MCP configuration as the server describes it. */
export type McpServer = z.infer<typeof mcpSchema>;

/** A published asset as the server describes it, of any kind. */
export type PublishedAsset = Skill | McpServer | Hook;

/** In the order commands list them. */
export const assetKindList = [
  "skill",
  "mcp",
  "hook",
] as const satisfies readonly AssetKind[];

export const isAssetKind = (value: unknown): value is AssetKind =>
  assetKindList.some((kind) => kind === value);

/** One row of the published catalog, neutral across asset kinds. */
export type CatalogAsset = {
  id: string;
  kind: AssetKind;
  name: string;
  origin: { type: string; id: string; slug: string; localOnly?: boolean };
  version: { number: number; description: string; label?: string };
};

type KindFacts = {
  one: string;
  a: string;
  many: string;
  command: string;
  route: string;
  folder: string;
  schema: ZodType;
};

type PackageFacts = KindFacts & {
  manifest: string;
  cachePath: readonly string[];
  scaffold: (name: string) => PackageEntry[];
};

const file = (path: string, text: string, executable = false) => ({
  path,
  data: Buffer.from(text),
  executable,
});

const hookManifest = (name: string) => `name: ${name}
description: Describe this Hook
implementations:
  claude:
    compatibility: supported
    scripts: [scripts/hook.sh]
    requirements:
      commands: [sh]
    events:
      SessionStart:
        - hooks:
            - type: command
              command: '\${BARNDOG_HOOK_ROOT}/scripts/hook.sh'
`;

/**
 * What differs between asset kinds. Code that needs a kind's word, route, folder
 * or schema reads it here instead of comparing `kind`.
 */
export const assetKinds = {
  skill: {
    one: "Skill",
    a: "a Skill",
    many: "Skills",
    /** `barndog skills …` */
    command: "skills",
    /** `/v1/skills/…` */
    route: "skills",
    /** Inside a workspace scope and `~/.barndog/installed/`. */
    folder: assetFolders.skill,
    schema: skillSchema,
    manifest: "SKILL.md",
    // Skills predate Hooks, so their cached packages sit at the cache root.
    cachePath: [],
    scaffold: (name: string): PackageEntry[] => [
      file(
        "SKILL.md",
        `---\nname: ${name}\ndescription: Describe this Skill\n---\n\nAdd instructions here.\n`,
      ),
    ],
  },
  mcp: {
    one: "MCP server",
    a: "an MCP server",
    many: "MCP servers",
    command: "mcp",
    route: "mcps",
    folder: assetFolders.mcp,
    schema: mcpSchema,
  },
  hook: {
    one: "Hook",
    a: "a Hook",
    many: "Hooks",
    command: "hooks",
    route: "hooks",
    folder: assetFolders.hook,
    schema: hookSchema,
    manifest: "hook.yaml",
    cachePath: ["hooks"],
    scaffold: (name: string): PackageEntry[] => [
      file("hook.yaml", hookManifest(name)),
      file(
        "scripts/hook.sh",
        "#!/bin/sh\n# Read native input; implement the desired behavior here.\ncat >/dev/null\n",
        true,
      ),
    ],
  },
} as const satisfies Record<AssetKind, KindFacts> &
  Record<PackageKind, PackageFacts>;

export const assetNotFound = (kind: AssetKind, name: string, origin: string) =>
  new CliError(
    `No ${assetKinds[kind].one} named ${name} in ${origin}.`,
    `barndog ${assetKinds[kind].command} search ${name}`,
  );

/**
 * A package's metadata: the `SKILL.md` front matter, or the parsed `hook.yaml`
 * manifest. Throws when the manifest is missing or invalid, or a Hook script it
 * names is missing.
 */
export function metadata(entries: PackageEntry[], kind: PackageKind = "skill") {
  if (kind === "skill") {
    return packageMetadata(entries);
  }

  if (!entries.some((e) => e.path === "hook.yaml")) {
    throw new PackageError("MISSING_PACKAGE_MANIFEST", "hook.yaml");
  }

  const manifest = hookManifestSchema.parse(
    parse(
      entries.find((e) => e.path === "hook.yaml")?.data.toString("utf8") ?? "",
    ),
  );

  for (const implementation of Object.values(manifest.implementations)) {
    if (implementation) {
      for (const script of implementation.scripts) {
        if (!entries.some((e) => e.path === script)) {
          throw new PackageError("MISSING_HOOK_SCRIPT", script);
        }
      }
    }
  }

  return manifest;
}
