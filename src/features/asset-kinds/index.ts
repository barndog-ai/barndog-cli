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
  packageKindList,
  type PackageKind,
} from "../../config/selection.js";
import { CliError, PackageError } from "../../errors.js";
import { only } from "../../shared/lookup.js";
import { validAssetName, validMcpName } from "../../shared/patterns.js";

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
  /** Whether a name can be this kind's folder, file and installed name. */
  validName: (name: string) => boolean;
  /** The naming rule as a sentence, for errors. */
  nameRule: string;
};

type PackageFacts = KindFacts & {
  manifest: string;
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

/** Skill and Hook names, which become folder names: the `NAME` shape. */
const ASSET_NAME_RULE =
  "Names use lowercase letters, numbers and single hyphens, at most 64 characters";

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
    validName: validAssetName,
    nameRule: ASSET_NAME_RULE,
    manifest: "SKILL.md",
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
    validName: validMcpName,
    nameRule:
      "MCP server names use letters, numbers, underscores and hyphens, at most 64 characters",
  },
  hook: {
    one: "Hook",
    a: "a Hook",
    many: "Hooks",
    command: "hooks",
    route: "hooks",
    folder: assetFolders.hook,
    schema: hookSchema,
    validName: validAssetName,
    nameRule: ASSET_NAME_RULE,
    manifest: "hook.yaml",
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
 * Which kind of package a folder holds, from the one manifest file it has at
 * its root (`SKILL.md` or `hook.yaml`). Throws when it has neither or both, or
 * when the command that asked (`expected`) is for the other kind.
 */
export function packageKindOf(
  entries: readonly PackageEntry[],
  expected: PackageKind | undefined,
): PackageKind {
  const kinds = packageKindList.filter((kind) =>
    entries.some((entry) => entry.path === assetKinds[kind].manifest),
  );

  const kind = only(kinds);
  if (!kind) {
    throw new CliError(
      kinds.length
        ? `This folder has both ${kinds.map((k) => assetKinds[k].manifest).join(" and ")}, so it isn't clear what to push.`
        : `This folder has no ${packageKindList.map((k) => assetKinds[k].manifest).join(" or ")}, so there is nothing to push.`,
      `Keep exactly one of ${packageKindList.map((k) => `${assetKinds[k].manifest} for ${assetKinds[k].a}`).join(" or ")}.`,
    );
  }

  if (expected && expected !== kind) {
    throw new CliError(
      `This folder holds ${assetKinds[kind].a}, not ${assetKinds[expected].a}.`,
      `barndog ${assetKinds[kind].command} push --origin <origin>`,
    );
  }

  return kind;
}

/**
 * A package's metadata: the `SKILL.md` front matter, or the parsed `hook.yaml`
 * manifest. Throws when the manifest is missing or invalid, or a Hook script it
 * names is missing.
 */
export function metadata(entries: PackageEntry[], kind: PackageKind) {
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
