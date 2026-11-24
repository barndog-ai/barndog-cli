/**
 * Doctor checks that would repeat one message per variable or per Hook,
 * grouped into one check per message with the names listed under it.
 */
import { adapters } from "../../harnesses/registry.js";
import { defined, only } from "../../shared/lookup.js";
import { assetKinds } from "../asset-kinds/index.js";
import {
  unassignedValueMessage,
  unsetValueMessage,
  type SyncEvent,
} from "../environment/events.js";
import type { Check, CheckRow } from "./check.js";

type UnsetVariable = Extract<SyncEvent, { type: "unset-variable" }>;

type Unsupported = Extract<SyncEvent, { type: "unsupported" }>;

const SHELL_NOTE =
  "Coding tools opened outside a terminal may not see your shell's variables either.";

/** Names under each label, each once, in the order they first appear. */
function rowsOf(
  entries: readonly { label: string; item: string }[],
): CheckRow[] {
  const rows = new Map<string, string[]>();
  for (const { label, item } of entries) {
    const items = rows.get(label) ?? [];
    if (!items.includes(item)) {
      items.push(item);
    }

    rows.set(label, items);
  }

  return [...rows].map(([label, items]) => ({ label, items }));
}

/** The `mcp env set` that fixes them: as specific as one server allows. */
function setFix(events: readonly UnsetVariable[]): string {
  const server = only([...new Set(events.map((event) => event.server))]);
  if (!server) {
    return "barndog mcp env set <server> <variable>";
  }

  const single = only(events);

  return single
    ? `barndog mcp env set ${server} ${single.variable}`
    : `barndog mcp env set ${server}`;
}

/**
 * One variable keeps its own sentence; several share one check that lists
 * them by server.
 */
function unsetCheck(
  events: readonly UnsetVariable[],
  wording: {
    single: (event: UnsetVariable) => string;
    many: string;
    item: (event: UnsetVariable) => string;
  },
): Check[] {
  const single = only(events);
  if (single) {
    return [
      {
        name: "MCP variable",
        status: "warn",
        detail: wording.single(single),
        fix: setFix(events),
      },
    ];
  }

  if (!events.length) {
    return [];
  }

  return [
    {
      name: "MCP variables",
      status: "warn",
      detail: wording.many,
      rows: rowsOf(
        events.map((event) => ({
          label: event.server,
          item: wording.item(event),
        })),
      ),
      fix: setFix(events),
    },
  ];
}

/**
 * One check for the variables with no value here, one for those told to read
 * a variable that has none, and one per value kept for no server.
 */
export function variableChecks(events: readonly SyncEvent[]): Check[] {
  const unset = events.filter(
    (event): event is UnsetVariable => event.type === "unset-variable",
  );

  const direct = unset.filter((event) => !event.from);
  const redirected = unset.filter((event) => event.from);

  const checks: Check[] = [
    ...unsetCheck(direct, {
      single: (event) =>
        `${unsetValueMessage(event)} BarnDog doesn't keep it and it isn't set in this shell. ${SHELL_NOTE}`,
      many: `${direct.length} variables have no value here, so their MCP servers can't use them. BarnDog doesn't keep them and they aren't set in this shell. ${SHELL_NOTE}`,
      item: (event) => event.variable,
    }),
    ...unsetCheck(redirected, {
      single: (event) => `${unsetValueMessage(event)} ${SHELL_NOTE}`,
      many: `${redirected.length} variables read another variable that has no value here. ${SHELL_NOTE}`,
      item: (event) => `${event.variable} from $${event.from}`,
    }),
  ];

  for (const event of events) {
    if (event.type === "unassigned-value") {
      checks.push({
        name: "MCP variable",
        status: "warn",
        detail: unassignedValueMessage(event.variable),
        fix: `barndog mcp env set <server> ${event.variable}`,
      });
    }
  }

  return checks;
}

/** One check per kind and reason, listing the assets skipped in each tool. */
export function unsupportedChecks(events: readonly SyncEvent[]): Check[] {
  const groups = new Map<string, Unsupported[]>();
  for (const event of events) {
    if (event.type === "unsupported") {
      const key = JSON.stringify([event.kind, event.reason]);
      groups.set(key, [...(groups.get(key) ?? []), event]);
    }
  }

  return [...groups.values()].map((group) => {
    const { kind, reason } = defined(
      group[0],
      "A group has at least one asset",
    );

    const skipped =
      group.length === 1
        ? `this ${assetKinds[kind].one}`
        : `these ${assetKinds[kind].many}`;

    return {
      name: "Unsupported",
      status: "warn",
      detail: `${reason}, so BarnDog skips ${skipped} there.`,
      rows: rowsOf(
        group.map((event) => ({
          label: adapters[event.harness].name,
          item: event.name,
        })),
      ),
    };
  });
}
