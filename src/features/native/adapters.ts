import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { coerce, satisfies, validRange } from "semver";
import {
  hookManifestSchema,
  mcpDefinitionSchema,
} from "@barndog-ai/api-contract";
import type { z } from "zod";
import { adapters } from "../../harnesses/registry.js";
import type { Harness } from "../../harnesses/types.js";
import { nativeFile, type NativeEntry } from "./configuration.js";
import { shellQuote } from "../../shared/shell.js";

const execute = promisify(execFile);

/**
 * Also sets the tool's own root variables, so a script written for the tool
 * finds its files and recognises where it runs.
 */
export const hookCommand = (root: string, command: string, harness?: Harness) =>
  `export ${["BARNDOG_HOOK_ROOT", ...(harness ? adapters[harness].hooks.rootVariables : [])].map((name) => `${name}=${shellQuote(root)}`).join(" ")}; ${command}`;

export async function executable(
  command: string,
  path = process.env.PATH ?? "",
) {
  for (const directory of command.includes("/")
    ? [""]
    : path.split(delimiter)) {
    const candidate = directory ? join(directory, command) : command;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* next PATH entry */
    }
  }
  return null;
}

export async function runtimeRequirements(
  harness: Harness,
  requirements: { commands: string[]; harnessVersion?: string },
) {
  for (const command of requirements.commands)
    if (!(await executable(command))) return `Missing runtime: ${command}`;
  if (requirements.harnessVersion) {
    if (!validRange(requirements.harnessVersion))
      return `Invalid declared harness version requirement: ${requirements.harnessVersion}`;
    const command = (
      await Promise.all(adapters[harness].commands.map((c) => executable(c)))
    ).find(Boolean);
    if (!command)
      return `Cannot verify ${harness} version: harness command is missing`;
    try {
      const { stdout } = await execute(command, ["--version"], {
        timeout: 5000,
        maxBuffer: 4096,
      });
      const version = coerce(stdout);
      if (!version || !satisfies(version, requirements.harnessVersion))
        return `${harness} does not meet ${requirements.harnessVersion}`;
    } catch {
      return `Cannot verify ${harness} version`;
    }
  }
  return null;
}

export function mcpEntry(
  harness: Harness,
  asset: { id: string; name: string },
  definition: z.infer<typeof mcpDefinitionSchema>,
  home: string,
): NativeEntry {
  const refs =
    definition.transport === "stdio"
      ? definition.environment
      : definition.headers;
  const env = Object.fromEntries(
    Object.entries(refs).map(([name, ref]) => [
      name,
      harness === "cursor"
        ? `\${env:${ref.secretRef}}`
        : `\${${ref.secretRef}}`,
    ]),
  );
  let value: Record<string, unknown>;
  if (definition.transport === "http")
    value =
      harness === "codex"
        ? {
            url: definition.url,
            ...(Object.keys(refs).length
              ? {
                  env_http_headers: Object.fromEntries(
                    Object.entries(refs).map(([k, v]) => [k, v.secretRef]),
                  ),
                }
              : {}),
          }
        : {
            ...(harness === "claude" ? { type: "http" } : {}),
            url: definition.url,
            ...(Object.keys(env).length ? { headers: env } : {}),
          };
  else if (harness === "codex") {
    // Native forwarding preserves reference-only storage. Renamed variables are
    // bound by a tiny local launcher, without writing their values to disk.
    const renamed = Object.entries(refs).some(
      ([key, ref]) => key !== ref.secretRef,
    );
    value = renamed
      ? {
          command: process.execPath,
          args: [
            fileURLToPath(new URL("./mcp-launch.js", import.meta.url)),
            Buffer.from(JSON.stringify(definition)).toString("base64url"),
          ],
          env_vars: Object.values(refs).map((v) => v.secretRef),
        }
      : {
          command: definition.command,
          args: definition.args,
          env_vars: Object.values(refs).map((v) => v.secretRef),
        };
  } else
    value = {
      ...(harness === "claude" ? { type: "stdio" } : {}),
      command: definition.command,
      args: definition.args,
      ...(Object.keys(env).length ? { env } : {}),
    };
  return {
    id: asset.id,
    kind: "mcp",
    harness,
    file: nativeFile(harness, "mcp", home),
    key: asset.name,
    value,
  };
}

export function hookEntries(
  harness: Harness,
  id: string,
  root: string,
  manifest: z.infer<typeof hookManifestSchema>,
  home: string,
): NativeEntry[] {
  const implementation = manifest.implementations[harness];
  if (!implementation) return [];
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
