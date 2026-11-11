import { resolve } from "node:path";
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

export function skillDirectory(harness: Harness, home: string): string {
  return resolve(home, adapters[harness].skillRoot);
}
