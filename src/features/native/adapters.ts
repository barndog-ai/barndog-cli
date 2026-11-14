import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { coerce, satisfies, validRange } from "semver";
import which from "which";
import type { HookManifest, McpDefinition } from "@barndog-ai/api-contract";
import { adapters, nativeFile } from "../../harnesses/registry.js";
import type { Harness } from "../../harnesses/types.js";
import { type NativeEntry } from "./configuration.js";
import { shellQuote } from "../../shared/shell.js";

const execute = promisify(execFile);

/**
 * Also sets the tool's own root variables, so a script written for the tool
 * finds its files and recognises where it runs.
 */
export const hookCommand = (root: string, command: string, harness?: Harness) =>
  `export ${["BARNDOG_HOOK_ROOT", ...(harness ? adapters[harness].hooks.rootVariables : [])].map((name) => `${name}=${shellQuote(root)}`).join(" ")}; ${command}`;

/** Where `command` runs from, trying Windows extensions there; null when it isn't on PATH. */
function executable(
  command: string,
  path = process.env.PATH ?? "",
): Promise<string | null> {
  return which(command, { path, nothrow: true });
}

/**
 * Checks required executables and optionally runs the harness version command;
 * returns the first issue or null.
 */
export async function runtimeRequirements(
  harness: Harness,
  requirements: { commands: string[]; harnessVersion?: string },
) {
  for (const command of requirements.commands) {
    if (!(await executable(command))) {
      return `Missing runtime: ${command}`;
    }
  }

  if (requirements.harnessVersion) {
    if (!validRange(requirements.harnessVersion)) {
      return `Invalid declared harness version requirement: ${requirements.harnessVersion}`;
    }

    const command = (
      await Promise.all(adapters[harness].commands.map((c) => executable(c)))
    ).find(Boolean);

    if (!command) {
      return `Cannot verify ${harness} version: harness command is missing`;
    }

    try {
      const { stdout } = await execute(command, ["--version"], {
        timeout: 5000,
        maxBuffer: 4096,
      });

      const version = coerce(stdout);
      if (!version || !satisfies(version, requirements.harnessVersion)) {
        return `${harness} does not meet ${requirements.harnessVersion}`;
      }
    } catch {
      return `Cannot verify ${harness} version`;
    }
  }

  return null;
}

/**
 * Builds a harness-specific MCP configuration entry with secret references;
 * does not write native settings.
 */
export function mcpEntry(
  harness: Harness,
  asset: { id: string; name: string },
  definition: McpDefinition,
  home: string,
): NativeEntry {
  return {
    id: asset.id,
    kind: "mcp",
    harness,
    file: nativeFile(harness, "mcp", home),
    key: asset.name,
    value: adapters[harness].mcp.server(
      definition,
      fileURLToPath(new URL("./mcp-launch.js", import.meta.url)),
    ),
  };
}

/**
 * Builds native Hook entries with commands rooted at the installed package;
 * missing implementations yield no entries.
 */
export function hookEntries(
  harness: Harness,
  { id, root, manifest }: { id: string; root: string; manifest: HookManifest },
  home: string,
): NativeEntry[] {
  const implementation = manifest.implementations[harness];
  if (!implementation) {
    return [];
  }

  return Object.entries(implementation.events).flatMap(([key, handlers]) =>
    handlers.map((handler) => ({
      id,
      kind: "hook" as const,
      harness,
      file: nativeFile(harness, "hook", home),
      key,
      value:
        "hooks" in handler
          ? {
              ...handler,
              hooks: handler.hooks.map((command) => ({
                ...command,
                type: "command",
                command: hookCommand(root, command.command, harness),
              })),
            }
          : {
              ...handler,
              command: hookCommand(root, handler.command, harness),
            },
    })),
  );
}
