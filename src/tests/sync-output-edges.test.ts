import { describe, expect, test } from "vitest";
import { renderSyncOutput } from "../ui/output.js";
import type { SyncEvent } from "../features/environment/events.js";

const mixed: SyncEvent[] = [
  {
    type: "native",
    action: "installed",
    kind: "mcp",
    name: "server",
    harness: "claude",
  },
  {
    type: "native",
    action: "installed",
    kind: "mcp",
    name: "server",
    harness: "codex",
  },
  {
    type: "native",
    action: "installed",
    kind: "hook",
    name: "check",
    harness: "claude",
  },
  {
    type: "native",
    action: "installed",
    kind: "hook",
    name: "another",
    harness: "claude",
  },
  {
    type: "native",
    action: "updated",
    kind: "mcp",
    name: "changed",
    harness: "claude",
  },
  {
    type: "native",
    action: "removed",
    kind: "mcp",
    name: "removed",
    harness: "claude",
  },
  {
    type: "native",
    action: "unchanged",
    kind: "mcp",
    name: "untouched",
    harness: "claude",
  },
  {
    type: "unsupported",
    kind: "hook",
    name: "unsupported",
    harness: "cursor",
    reason: "No implementation",
  },
  {
    type: "invalid",
    kind: "skill",
    name: "broken",
    reason: "Invalid manifest",
  },
  { type: "notice", message: "Using cached content" },
];

const TITLE = "\nBarnDog sync\n";

const changedRows = [
  "  + installed    hook   another      Claude Code",
  "  + installed    hook   check        Claude Code",
  "  + installed    mcp    server       Claude Code, Codex",
  "  ~ updated      mcp    changed      Claude Code",
  "  - removed      mcp    removed      Claude Code",
  "  ! skipped      skill  broken       Invalid manifest",
  "  ! unsupported  hook   unsupported  Cursor · No implementation",
];

const SUMMARY =
  "3 installed, 1 updated, 1 removed, 1 unchanged, 1 skipped, 1 unsupported";

describe("a sync with every kind of event", () => {
  test("lists changes by action, merges harnesses and hides unchanged rows", () => {
    expect(renderSyncOutput(mixed)).toEqual([
      TITLE,
      ...changedRows,
      "",
      `! Sync complete · ${SUMMARY}`,
      "A restart of your coding tools may be required to pick up the changes.",
      "",
      "! Using cached content",
      "",
    ]);
  });

  test("verbose output adds the unchanged rows last", () => {
    expect(renderSyncOutput(mixed, { verbose: true })).toEqual([
      TITLE,
      ...changedRows,
      "    unchanged    mcp    untouched    Claude Code",
      "",
      `! Sync complete · ${SUMMARY}`,
      "A restart of your coding tools may be required to pick up the changes.",
      "",
      "! Using cached content",
      "",
    ]);
  });

  test("a preview points to the sync command instead of asking for a restart", () => {
    expect(renderSyncOutput(mixed, { preview: true })).toEqual([
      TITLE,
      ...changedRows,
      "",
      `! Preview · ${SUMMARY}`,
      "Next: barndog sync  to apply these changes",
      "",
      "! Using cached content",
      "",
    ]);
  });

  test("a title replaces the default one", () => {
    expect(renderSyncOutput([], { title: "doctor" })[0]).toBe(
      "\nBarnDog doctor\n",
    );
  });
});

describe("a sync that changed nothing", () => {
  test("with no events is up to date", () => {
    expect(renderSyncOutput([])).toEqual([
      TITLE,
      "✔ Sync complete",
      "Everything is up to date.",
      "",
    ]);
  });

  test("with only unchanged assets counts them but shows no table", () => {
    expect(
      renderSyncOutput([
        {
          type: "native",
          action: "unchanged",
          kind: "mcp",
          name: "a",
          harness: "claude",
        },
        {
          type: "native",
          action: "unchanged",
          kind: "hook",
          name: "b",
          harness: "claude",
        },
      ]),
    ).toEqual([
      TITLE,
      "✔ Sync complete · 2 unchanged",
      "Everything is up to date.",
      "",
    ]);
  });

  test("with only unsupported assets reports them without asking for a restart", () => {
    expect(
      renderSyncOutput([
        {
          type: "unsupported",
          kind: "hook",
          name: "check",
          harness: "cursor",
          reason: "Missing runtime",
        },
      ]),
    ).toEqual([
      TITLE,
      "  ! unsupported  hook  check  Cursor · Missing runtime",
      "",
      "✔ Sync complete · 1 unsupported",
      "Everything is up to date.",
      "",
    ]);
  });

  test("a preview of nothing says everything is up to date", () => {
    expect(renderSyncOutput([], { preview: true })).toEqual([
      TITLE,
      "✔ Preview",
      "Everything is up to date.",
      "",
    ]);
  });
});

describe("internal entries", () => {
  test("a changed sync registration needs a restart but is not listed or counted", () => {
    expect(
      renderSyncOutput([
        {
          type: "native",
          kind: "sync",
          name: "sync",
          harness: "claude",
          action: "updated",
        },
      ]),
    ).toEqual([
      TITLE,
      "✔ Sync complete",
      "A restart of your coding tools may be required to pick up the changes.",
      "",
    ]);
  });

  test("an unchanged knowledge registration is listed only when verbose", () => {
    const unchanged: SyncEvent[] = [
      {
        type: "native",
        kind: "knowledge",
        name: "knowledge",
        harness: "claude",
        action: "unchanged",
      },
    ];

    expect(renderSyncOutput(unchanged)).toEqual([
      TITLE,
      "✔ Sync complete",
      "Everything is up to date.",
      "",
    ]);

    expect(renderSyncOutput(unchanged, { verbose: true })).toEqual([
      TITLE,
      "    unchanged  knowledge  knowledge  Claude Code",
      "",
      "✔ Sync complete",
      "Everything is up to date.",
      "",
    ]);
  });
});

describe("notices", () => {
  test("a notice makes a sync incomplete: it warns and says only that nothing else changed", () => {
    expect(renderSyncOutput([{ type: "notice", message: "Cached" }])).toEqual([
      TITLE,
      "! Sync complete",
      "Nothing else changed.",
      "",
      "! Cached",
      "",
    ]);
  });

  test("a notice in a preview is incomplete too", () => {
    expect(
      renderSyncOutput([{ type: "notice", message: "Cached" }], {
        preview: true,
      }),
    ).toEqual([
      TITLE,
      "! Preview",
      "Nothing else changed.",
      "",
      "! Cached",
      "",
    ]);
  });

  test("a variable with no value names the servers that need it and how to set it", () => {
    expect(
      renderSyncOutput([
        {
          type: "unset-variable",
          variable: "RESOLVE_SCRIPT_API",
          servers: ["davinci-resolve", "render"],
        },
      ]),
    ).toEqual([
      TITLE,
      "✔ Sync complete",
      "Everything is up to date.",
      "",
      "! RESOLVE_SCRIPT_API has no value here, so davinci-resolve, render can't use it.",
      "  Fix: barndog mcp env set RESOLVE_SCRIPT_API",
      "",
    ]);
  });

  test("a notice does not hide changes that were made", () => {
    expect(
      renderSyncOutput([
        {
          type: "native",
          action: "installed",
          kind: "mcp",
          name: "server",
          harness: "claude",
        },
        { type: "notice", message: "Cached" },
      ]),
    ).toEqual([
      TITLE,
      "  + installed  mcp  server  Claude Code",
      "",
      "! Sync complete · 1 installed",
      "A restart of your coding tools may be required to pick up the changes.",
      "",
      "! Cached",
      "",
    ]);
  });
});

describe("clashes and invalid assets", () => {
  test("a clash is skipped with the command that renames it", () => {
    expect(
      renderSyncOutput([
        {
          type: "clash",
          kind: "skill",
          name: "review",
          installed: { name: "review", origin: "org" },
          skipped: {
            name: "review",
            origin: "team/web",
            rename: "team-web-review",
          },
        },
      ]),
    ).toEqual([
      TITLE,
      "  ! skipped  skill  review  team/web · name taken by org",
      "",
      "! Sync complete · 1 skipped",
      "Nothing else changed.",
      "",
      "! Skill review from team/web was skipped: org already installs one with that name.",
      "  Fix: barndog skills rename review --origin team/web --as team-web-review",
      "",
    ]);
  });
});
