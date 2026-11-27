/**
 * The MCP variables a sync found with no value, grouped the way `doctor`
 * groups them: one warning for several variables, listed by server, with one
 * fix, rather than a warning and a fix per variable.
 */
import { variableChecks } from "../features/doctor/grouped.js";
import type { SyncEvent } from "../features/environment/events.js";
import { hint, labelledLists, warn } from "./format.js";

/** Lines under a warning start where its text does. */
const UNDER = "  ";

export function variableProblemLines(events: readonly SyncEvent[]): string[] {
  return variableChecks(events).flatMap((check) => [
    "",
    `${warn("!")} ${check.detail}`,
    ...labelledLists(check.rows ?? [], { indent: UNDER.length + 2 }),
    ...(check.fix ? [`${UNDER}${hint(check.fix, "Fix")}`] : []),
  ]);
}
