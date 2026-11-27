/** Names listed under one label in a grouped check: a server's variables, a tool's Hooks. */
export type CheckRow = { label: string; items: string[] };

export type Check = {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  /** Present when one check stands for several things with the same problem. */
  rows?: CheckRow[];
  /** Aligned columns under the detail, such as a Hook, its tool and what it lacks. */
  table?: string[][];
  fix?: string;
  /** A command that deletes or changes something; `fix` says it in words. */
  command?: string;
};

/**
 * What `barndog doctor` found. `hooksMissingTools` counts Hooks with no
 * implementation for a selected tool; it is a tip, not a problem, and stays
 * out of `--json`.
 */
export type DoctorReport = { checks: Check[]; hooksMissingTools: number };
