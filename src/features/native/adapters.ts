import type { RuntimeContext } from "../../runtime.js";
import type { HookManifest, McpDefinition } from "@barndog-ai/api-contract";
import { adapters, nativeFile } from "../../harnesses/registry.js";
import type {
  Harness,
  HookHarness,
  KeptValues,
} from "../../harnesses/types.js";
import { secretRefs } from "../../harnesses/formats.js";
import { type NativeEntry } from "./configuration.js";
import { hookCommand } from "./hook-shell.js";
import { runtimeRequirements, type HookSkip } from "./requirements.js";

/**
 * Why a Hook can't be installed for a tool: no implementation for it, or
 * something its implementation needs is missing here. Null when it can.
 */
export async function hookIssue(
  harness: HookHarness,
  manifest: HookManifest,
  runtime: RuntimeContext,
): Promise<HookSkip | null> {
  const implementation = manifest.implementations[harness];
  if (!implementation) {
    return { type: "no-implementation" };
  }

  const requirement = await runtimeRequirements(
    harness,
    implementation.requirements,
    runtime,
  );

  return requirement && { type: "missing-requirement", requirement };
}

/**
 * Builds a harness-specific MCP configuration entry; does not write native
 * settings. Variables in `kept` are written as their values, the rest as
 * references to local environment variables.
 */
export function mcpEntry(
  harness: Harness,
  server: { id: string; name: string; definition: McpDefinition },
  kept: KeptValues,
  runtime: RuntimeContext,
): NativeEntry {
  const { home } = runtime;

  const used = Object.fromEntries(
    Object.values(secretRefs(server.definition)).flatMap((ref) => {
      const value = kept[ref.secretRef];

      return value === undefined ? [] : [[ref.secretRef, value] as const];
    }),
  );

  return {
    id: server.id,
    kind: "mcp",
    harness,
    file: nativeFile(harness, "mcp", home),
    key: server.name,
    value: adapters[harness].mcp.server(
      server.definition,
      used,
      runtime.platform,
    ),
    ...(Object.keys(used).length
      ? {
          secrets: Object.entries(used).map(([variable, value]) => ({
            variable,
            value,
          })),
        }
      : {}),
  };
}

/**
 * Builds native Hook entries with commands rooted at the installed package;
 * missing implementations yield no entries.
 */
export function hookEntries(
  harness: HookHarness,
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
