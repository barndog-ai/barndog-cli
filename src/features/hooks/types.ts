import type { Hook } from "../asset-kinds/index.js";

/** What a Hook declares for one coding tool, and what this machine lacks to run it. */
type HarnessCompatibility = Hook["compatibility"][number] & {
  /** Null when every requirement is met. */
  runtimeIssue: string | null;
};

export type HookCompatibility = {
  /** A version number in Cloud, a Git object name in a Git or local workspace. */
  version: number | string;
  compatibility: HarnessCompatibility[];
};
