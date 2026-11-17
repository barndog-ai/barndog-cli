import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { cursor } from "./cursor.js";
import { opencode } from "./opencode.js";
import { join, resolve } from "node:path";

import type {
  Adapters,
  Harness,
  HarnessAdapter,
  HookHarness,
} from "./types.js";

export type { Harness, HookHarness, DetectedHarness } from "./types.js";

export const harnesses = ["claude", "codex", "cursor", "opencode"] as const;

/** The tools with command hooks, in the order `harnesses` lists them. */
export const hookHarnesses = ["claude", "codex", "cursor"] as const;

export const adapters: Adapters = {
  claude,
  codex,
  cursor,
  opencode,
};

export function isHarness(value: unknown): value is Harness {
  return (
    typeof value === "string" && harnesses.some((harness) => harness === value)
  );
}

export function isHookHarness(value: unknown): value is HookHarness {
  return (
    typeof value === "string" &&
    hookHarnesses.some((harness) => harness === value)
  );
}

/**
 * The harness whose hook settings live at a repository path, such as
 * `.claude/settings.json` (Claude Code) or `.codex/config.toml` (Codex);
 * undefined for any other file.
 */
export function hookSettingsOwner(path: string): HookHarness | undefined {
  return hookHarnesses.find((harness) =>
    adapters[harness].hooks.settings.some((pattern) => pattern.test(path)),
  );
}

export function skillDirectory(harness: Harness, home: string): string {
  return resolve(home, adapters[harness].skillRoot);
}

/**
 * What BarnDog writes into a coding tool's own settings files: MCP servers,
 * Hooks, the knowledge index and the sync reminder.
 */
export const nativeKinds = ["mcp", "hook", "knowledge", "sync"] as const;

export type NativeKind = (typeof nativeKinds)[number];

/**
 * Resolves the native settings file under the supplied home. MCP entries go to
 * the tool's MCP file; the rest to its hook settings, or for a tool without
 * command hooks, to BarnDog's plugin module.
 */
export function nativeFile(harness: Harness, kind: NativeKind, home: string) {
  const adapter: HarnessAdapter = adapters[harness];
  if (kind === "mcp") {
    return join(home, adapter.mcp.file);
  }

  return join(home, adapter.hooks ? adapter.hooks.file : adapter.plugin.file);
}
