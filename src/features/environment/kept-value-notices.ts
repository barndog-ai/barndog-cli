/**
 * Notices saying where a sync wrote kept MCP values and where it took them
 * out. One server usually has an entry in several tools' settings files, so
 * the variables every file shares go in one notice naming all the files, and
 * each file gets a notice of its own only for the variables it alone has.
 */
import type { SyncEvent } from "./events.js";

/** Kept values written into, or taken out of, one settings file for one server. */
export type KeptValueChange = {
  action: "wrote" | "removed";
  server: string;
  file: string;
  variables: readonly string[];
};

const files = new Intl.ListFormat("en", { type: "conjunction" });

const plural = (variables: readonly string[]) =>
  variables.length === 1 ? "value of" : "values of";

function message(change: {
  action: KeptValueChange["action"];
  server: string;
  files: readonly string[];
  variables: readonly string[];
}): string {
  const { action, server, variables } = change;
  const listed = `${plural(variables)} ${variables.join(", ")}`;
  const where = files.format(change.files);

  if (action === "removed") {
    return `Removed the kept ${listed} from ${where} for ${server}.`;
  }

  const stay = variables.length === 1 ? "It stays" : "They stay";

  return `Wrote the kept ${listed} into ${where} for ${server}. ${stay} on this machine.`;
}

/** The notices for `changes`, one per server and action, then one per file for what only it has. */
export function keptValueNotices(
  changes: readonly KeptValueChange[],
): SyncEvent[] {
  const groups = new Map<
    string,
    Pick<KeptValueChange, "action" | "server"> & { changes: KeptValueChange[] }
  >();

  for (const change of changes.filter((c) => c.variables.length)) {
    const key = JSON.stringify([change.action, change.server]);
    const group = groups.get(key) ?? { ...change, changes: [] };
    group.changes.push(change);
    groups.set(key, group);
  }

  return [...groups.values()].flatMap(({ action, server, changes: group }) => {
    const [first, ...rest] = group;
    const shared = rest.length
      ? (first?.variables ?? []).filter((variable) =>
          rest.every((change) => change.variables.includes(variable)),
        )
      : [];

    const notices = shared.length
      ? [{ action, server, files: group.map((c) => c.file), variables: shared }]
      : [];

    for (const change of group) {
      const own = change.variables.filter((v) => !shared.includes(v));
      if (own.length) {
        notices.push({ action, server, files: [change.file], variables: own });
      }
    }

    return notices.map((notice) => ({
      type: "notice" as const,
      message: message(notice),
    }));
  });
}
