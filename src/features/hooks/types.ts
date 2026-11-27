import type { Hook } from "../asset-kinds/index.js";
import type { MissingRequirement } from "../native/requirements.js";

/** What a Hook declares for one coding tool, and what this machine lacks to run it. */
export type HarnessCompatibility = Hook["compatibility"][number] & {
  /** What its implementation needs that this machine lacks; empty without an implementation. */
  missingRequirements: MissingRequirement[];
  /** The same in words, or why there is nothing to run; null when it can run. */
  runtimeIssue: string | null;
};

export type HookCompatibility = {
  /** A version number in Cloud, a Git object name in a Git or local workspace. */
  version: number | string;
  compatibility: HarnessCompatibility[];
};
