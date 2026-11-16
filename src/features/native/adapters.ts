import type { RuntimeContext } from "../../runtime.js";
import { fileURLToPath } from "node:url";
import { coerce, satisfies, validRange } from "semver";
import {
  programOutput,
  findExecutable,
  runtimeExecutable,
} from "../../platform.js";
import type { HookManifest, McpDefinition } from "@barndog-ai/api-contract";
import { adapters, nativeFile } from "../../harnesses/registry.js";
import type { Harness } from "../../harnesses/types.js";
import { type NativeEntry } from "./configuration.js";
import { hookCommand } from "./hook-shell.js";

/** A `--version` answer is one short line; anything slower or longer is broken. */
const VERSION_TIMEOUT_MS = 5000;
const VERSION_OUTPUT_LIMIT_BYTES = 4096;

/**
 * Checks required executables and optionally runs the harness version command;
 * returns the first issue or null.
 */
export async function runtimeRequirements(
  harness: Harness,
  requirements: { commands: string[]; harnessVersion?: string },
  runtime: RuntimeContext,
) {
  for (const command of requirements.commands) {
    if (!(await runtimeExecutable(command, runtime))) {
      return `Missing runtime: ${command}`;
    }
  }

  if (requirements.harnessVersion) {
    if (!validRange(requirements.harnessVersion)) {
      return `Invalid declared harness version requirement: ${requirements.harnessVersion}`;
    }

    const command = (
      await Promise.all(
        adapters[harness].commands.map((c) => findExecutable(c, runtime)),
      )
    ).find(Boolean);

    if (!command) {
      return `Cannot verify ${harness} version: harness command is missing`;
    }

    try {
      const stdout = await programOutput(command, ["--version"], runtime, {
        timeoutMs: VERSION_TIMEOUT_MS,
        maxBytes: VERSION_OUTPUT_LIMIT_BYTES,
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
  runtime: RuntimeContext,
): NativeEntry {
  const { home } = runtime;

  return {
    id: asset.id,
    kind: "mcp",
    harness,
    file: nativeFile(harness, "mcp", home),
    key: asset.name,
    value: adapters[harness].mcp.server(
      definition,
      fileURLToPath(new URL("../../entry/mcp-launch.js", import.meta.url)),
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
  runtime: RuntimeContext,
): NativeEntry[] {
  const { home } = runtime;

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
                command: hookCommand(
                  root,
                  command.command,
                  harness,
                  runtime.platform,
                ),
              })),
            }
          : {
              ...handler,
              command: hookCommand(
                root,
                handler.command,
                harness,
                runtime.platform,
              ),
            },
    })),
  );
}
