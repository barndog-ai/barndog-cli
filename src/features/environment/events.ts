import type { Link } from "../../config/state.js";
import type { Harness } from "../../harnesses/types.js";

/** One thing a sync did or noticed, reported to the user in order. */
export type SyncEvent =
  | {
      type: "native";
      action: "installed" | "updated" | "removed" | "unchanged";
      kind: "mcp" | "hook" | "knowledge" | "sync";
      harness: Harness;
      name: string;
    }
  | {
      type: "unsupported";
      kind: "mcp" | "hook";
      harness: Harness;
      name: string;
      reason: string;
    }
  | { type: "disabled"; id: string }
  | { type: "notice"; message: string }
  | {
      type: "invalid";
      kind: "skill" | "mcp" | "hook";
      name: string;
      reason: string;
    }
  | {
      type: "clash";
      kind: "skill" | "mcp";
      name: string;
      installed: { name: string; origin: string };
      skipped: { name: string; origin: string; rename: string };
    }
  | { type: "installed" | "updated" | "removed" | "unchanged"; link: Link };
