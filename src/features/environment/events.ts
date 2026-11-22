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
  /**
   * A variable an installed MCP server refers to that has no value here: not
   * kept by BarnDog, not in this environment. `from` is the variable it was
   * told to read instead (`mcp env set --from`).
   */
  | { type: "unset-variable"; server: string; variable: string; from?: string }
  /** A value a version 1 `secrets.json` kept that no MCP server has yet. */
  | { type: "unassigned-value"; variable: string }
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

/** What an `unset-variable` event means, as one sentence. */
export function unsetValueMessage(event: {
  server: string;
  variable: string;
  from?: string;
}): string {
  return event.from
    ? `${event.from} has no value here, so ${event.server} can't read ${event.variable} from it.`
    : `${event.variable} has no value here, so ${event.server} can't use it.`;
}

/** What an `unassigned-value` event means, as one sentence. */
export const unassignedValueMessage = (variable: string) =>
  `BarnDog keeps a value for ${variable} from before each value belonged to one MCP server, and no server has it yet.`;
