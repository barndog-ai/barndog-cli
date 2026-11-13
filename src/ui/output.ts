import { LoginRequiredError } from "../features/auth/transport.js";
import { styleText } from "node:util";
import { homedir } from "node:os";
import { basename, isAbsolute, relative, sep } from "node:path";
import { SetupRequiredError } from "../config/settings.js";
import type { SyncEvent } from "../features/environment/events.js";
import { adapters, isHarness } from "../harnesses/registry.js";
import { primary, danger } from "./theme.js";
import {
  bad,
  bold,
  dim,
  heading,
  hint,
  json,
  ok,
  table,
  warn,
} from "./format.js";
import { ApiError } from "@barndog-ai/api-contract";

import { CliError, friendlyHint, friendlyMessage } from "../errors.js";
import { assetKinds } from "../features/asset-kinds/index.js";

export function displayPath(path: string): string {
  const homeRelative = relative(homedir(), path);
  if (!homeRelative) {
    return "~";
  }

  if (
    homeRelative !== ".." &&
    !homeRelative.startsWith(`..${sep}`) &&
    !isAbsolute(homeRelative)
  ) {
    return `~${sep}${homeRelative}`;
  }

  return path;
}

type Action =
  "installed" | "updated" | "removed" | "unchanged" | "unsupported" | "skipped";

type Row = {
  action: Action;
  kind: string;
  name: string;
  harnesses: Set<string>;
  note?: string;
};

const marks: Record<Action, (text: string) => string> = {
  installed: (text) => ok(`+ ${text}`),
  updated: (text) => primary(`~ ${text}`),
  removed: (text) => bad(`- ${text}`),
  unchanged: (text) => dim(`  ${text}`),
  unsupported: (text) => warn(`! ${text}`),
  skipped: (text) => warn(`! ${text}`),
};

/** BarnDog's own entries in each tool's configuration, not assets the user manages. */
const internalKinds = new Set(["knowledge", "sync"]);

function rows(events: SyncEvent[]): Row[] {
  const byKey = new Map<string, Row>();
  const add = ({
    action,
    kind,
    name,
    harness,
    note,
  }: {
    action: Action;
    kind: string;
    name: string;
    harness?: string;
    note?: string;
  }) => {
    const key = `${action}\0${kind}\0${name}\0${note ?? ""}`;
    const row = byKey.get(key) ?? {
      action,
      kind,
      name,
      harnesses: new Set<string>(),
      note,
    };

    if (isHarness(harness)) {
      row.harnesses.add(adapters[harness].name);
    }

    byKey.set(key, row);
  };

  for (const event of events) {
    if (event.type === "disabled" || event.type === "notice") {
      continue;
    }

    if (event.type === "invalid") {
      add({
        action: "skipped",
        kind: event.kind,
        name: event.name,
        note: event.reason,
      });
    } else if (event.type === "clash") {
      add({
        action: "skipped",
        kind: event.kind,
        name: event.skipped.name,
        note: `${event.skipped.origin} · name taken by ${event.installed.origin}`,
      });
    } else if (event.type === "unsupported") {
      add({
        action: "unsupported",
        kind: event.kind,
        name: event.name,
        harness: event.harness,
        note: event.reason,
      });
    } else if (event.type === "native") {
      add({
        action: event.action,
        kind: event.kind,
        name: event.name,
        harness: event.harness,
      });
    } else {
      add({
        action: event.type,
        kind: "skill",
        name: basename(event.link.target),
        harness: event.link.harness,
      });
    }
  }

  const order: Action[] = [
    "installed",
    "updated",
    "removed",
    "skipped",
    "unsupported",
    "unchanged",
  ];

  return [...byKey.values()].sort(
    (a, b) =>
      order.indexOf(a.action) - order.indexOf(b.action) ||
      a.kind.localeCompare(b.kind) ||
      a.name.localeCompare(b.name),
  );
}

export function renderSyncOutput(
  events: SyncEvent[],
  options: { title?: string; verbose?: boolean; preview?: boolean } = {},
): string[] {
  const all = rows(events);
  const assets = all.filter((row) => !internalKinds.has(row.kind));
  const shown = options.verbose
    ? all
    : assets.filter((row) => row.action !== "unchanged");

  const count = (action: Action) =>
    assets.filter((row) => row.action === action).length;

  // Internal entries stay out of the counts, but a change to one still needs a restart.
  const changed = all.some((row) =>
    ["installed", "updated", "removed"].includes(row.action),
  );

  // Something was left out or read from an old copy, so "up to date" would be untrue.
  const incomplete =
    count("skipped") > 0 || events.some((event) => event.type === "notice");

  const quiet = incomplete
    ? dim("Nothing else changed.")
    : dim("Everything is up to date.");

  const summary = [
    ...(["installed", "updated", "removed", "unchanged"] as const).flatMap(
      (action) => (count(action) ? [`${count(action)} ${action}`] : []),
    ),
    ...(count("skipped") ? [`${count("skipped")} skipped`] : []),
    ...(count("unsupported") ? [`${count("unsupported")} unsupported`] : []),
  ].join(", ");

  const output = [`\n${heading(options.title ?? "sync")}\n`];
  if (shown.length) {
    output.push(
      ...table(
        shown.map((row) => [
          marks[row.action](row.action),
          dim(row.kind),
          bold(row.name),
          row.note
            ? `${[...row.harnesses].join(", ")}${row.harnesses.size ? " · " : ""}${row.note}`
            : dim([...row.harnesses].join(", ")),
        ]),
      ),
      "",
    );
  }

  output.push(
    `${incomplete ? warn("!") : ok("✔")} ${options.preview ? "Preview" : "Sync complete"}${summary ? ` · ${summary}` : ""}`,
  );

  if (options.preview) {
    output.push(
      changed
        ? hint("barndog sync", "Next") + dim("  to apply these changes")
        : quiet,
    );
  } else {
    output.push(
      changed
        ? dim("Restart your coding tools to pick up the changes.")
        : quiet,
    );
  }

  for (const event of events) {
    if (event.type === "notice") {
      output.push("", `${warn("!")} ${event.message}`);
    } else if (event.type === "clash") {
      output.push(
        "",
        `${warn("!")} ${assetKinds[event.kind].one} ${bold(event.skipped.name)} from ${event.skipped.origin} was skipped: ${event.installed.origin} already installs one with that name.`,
        `  ${hint(`barndog ${assetKinds[event.kind].command} rename ${event.skipped.name} --origin ${event.skipped.origin} --as ${event.skipped.rename}`, "Fix")}`,
      );
    }
  }

  output.push("");

  return output;
}

function describeError(error: unknown): { message: string; fix?: string } {
  if (error instanceof LoginRequiredError) {
    return { message: "You're not signed in.", fix: "barndog login" };
  }

  if (error instanceof SetupRequiredError) {
    return {
      message: "BarnDog isn't set up on this machine yet.",
      fix: "barndog init",
    };
  }

  if (error instanceof CliError) {
    return { message: error.message, fix: error.hint };
  }

  if (error instanceof ApiError && error.status === 500) {
    return {
      message: `The BarnDog server had a problem and couldn't finish this (${error.status}). If you run it yourself, check that it and its database are up.`,
    };
  }

  if (error instanceof TypeError && error.message === "fetch failed") {
    return {
      message:
        "Can't reach the BarnDog server. Check your connection and that the server is running.",
    };
  }

  return { message: friendlyMessage(error), fix: friendlyHint(error) };
}

export function renderError(error: unknown): string {
  const stream = process.stderr;
  const { message, fix } = describeError(error);

  return `${danger("✖", stream)} ${message}${fix ? `\n  ${styleText("dim", "Fix:", { stream })} ${styleText("bold", fix, { stream })}` : ""}`;
}

/** The same failure for `--json` callers, who parse rather than read. */
export function renderJsonError(error: unknown): string {
  const { message, fix } = describeError(error);

  return json({
    error: {
      message,
      ...(fix ? { fix } : {}),
      ...(error instanceof ApiError ? { status: error.status } : {}),
    },
  });
}
