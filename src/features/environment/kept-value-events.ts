/**
 * Events saying where a sync wrote kept MCP values and where it took them
 * out. One server usually has an entry in several tools' settings files, so
 * the variables every file shares go in one event naming all the files, and
 * each file gets an event of its own only for the variables it alone has.
 */
import type { KeptValuesEvent } from "./events.js";

/** Kept values written into, or taken out of, one settings file for one server. */
export type KeptValueWrite = {
  action: KeptValuesEvent["action"];
  server: string;
  file: string;
  variables: readonly string[];
};

/** One server's writes of one action, in the order sync made them. */
type WriteGroup = Pick<KeptValueWrite, "action" | "server"> & {
  writes: KeptValueWrite[];
};

/** The events for `writes`, one per server and action, then one per file for what only it has. */
export function keptValueEvents(
  writes: readonly KeptValueWrite[],
): KeptValuesEvent[] {
  const groups = new Map<string, WriteGroup>();

  for (const write of writes.filter((w) => w.variables.length)) {
    const key = JSON.stringify([write.action, write.server]);
    const group = groups.get(key) ?? { ...write, writes: [] };
    group.writes.push(write);
    groups.set(key, group);
  }

  return [...groups.values()].flatMap(({ action, server, writes: group }) => {
    const [first, ...rest] = group;
    const shared = rest.length
      ? (first?.variables ?? []).filter((variable) =>
          rest.every((change) => change.variables.includes(variable)),
        )
      : [];

    const events: KeptValuesEvent[] = shared.length
      ? [
          {
            type: "kept-values",
            action,
            server,
            variables: shared,
            files: group.map((w) => w.file),
          },
        ]
      : [];

    for (const write of group) {
      const own = write.variables.filter((v) => !shared.includes(v));
      if (own.length) {
        events.push({
          type: "kept-values",
          action,
          server,
          variables: own,
          files: [write.file],
        });
      }
    }

    return events;
  });
}
