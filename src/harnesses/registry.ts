import { join, resolve } from "node:path";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { cursor } from "./cursor.js";
import type { Harness, HarnessAdapter } from "./types.js";

export type { Harness, DetectedHarness } from "./types.js";

export const harnesses = ["claude", "codex", "cursor"] as const;

export const adapters: Record<Harness, HarnessAdapter> = {
  claude,
  codex,
  cursor,
};

export function isHarness(value: unknown): value is Harness {
  return (
    typeof value === "string" && harnesses.some((harness) => harness === value)
  );
}

/**
 * The harness whose hook settings live at a repository path, such as
 * `.claude/settings.json` (Claude Code) or `.codex/config.toml` (Codex);
 * undefined for any other file.
 */
export function hookSettingsOwner(path: string): Harness | undefined {
  return harnesses.find((harness) =>
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
 * Resolves the native settings file under the supplied home; non-MCP entries
 * use the harness Hook file.
 */
export const nativeFile = (harness: Harness, kind: NativeKind, home: string) =>
  join(
    home,
    kind === "mcp" ? adapters[harness].mcp.file : adapters[harness].hooks.file,
  );
