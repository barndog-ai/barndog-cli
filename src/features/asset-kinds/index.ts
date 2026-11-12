import { hookSchema, mcpSchema, skillSchema } from "@barndog-ai/api-contract";
import type { PackageEntry } from "@barndog-ai/api-contract/package";
import type { ZodType } from "zod";
import type { AssetKind } from "../asset-selection/types.js";
import { CliError } from "../../errors.js";

export type { AssetKind };

/** Kinds published as a folder of files; MCP configurations are a single definition. */
export type PackageKind = Exclude<AssetKind, "mcp">;

/** In the order commands list them. */
export const assetKindList = [
  "skill",
  "mcp",
  "hook",
] as const satisfies readonly AssetKind[];

export const packageKindList = [
  "skill",
  "hook",
] as const satisfies readonly PackageKind[];

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
    folder: "skills",
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
    folder: "mcp",
    schema: mcpSchema,
  },
  hook: {
    one: "Hook",
    a: "a Hook",
    many: "Hooks",
    command: "hooks",
    route: "hooks",
    folder: "hooks",
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
