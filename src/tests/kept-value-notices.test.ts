import { expect, test } from "vitest";
import { keptValueNotices } from "../features/environment/kept-value-notices.js";

const messages = (changes: Parameters<typeof keptValueNotices>[0]) =>
  keptValueNotices(changes).map((event) =>
    event.type === "notice" ? event.message : "",
  );

test("variables every file shares go in one notice; each file lists only its own", () => {
  expect(
    messages([
      {
        action: "removed",
        server: "repl",
        file: "~/.claude.json",
        variables: ["A", "B", "C"],
      },
      {
        action: "removed",
        server: "repl",
        file: "~/.codex/config.toml",
        variables: ["A", "B", "D"],
      },
      {
        action: "wrote",
        server: "repl",
        file: "~/.claude.json",
        variables: ["KEY"],
      },
      {
        action: "wrote",
        server: "repl",
        file: "~/.codex/config.toml",
        variables: ["KEY"],
      },
      {
        action: "wrote",
        server: "repl",
        file: "~/.cursor/mcp.json",
        variables: [],
      },
      {
        action: "removed",
        server: "other",
        file: "~/.claude.json",
        variables: ["A"],
      },
    ]),
  ).toStrictEqual([
    "Removed the kept values of A, B from ~/.claude.json and ~/.codex/config.toml for repl.",
    "Removed the kept value of C from ~/.claude.json for repl.",
    "Removed the kept value of D from ~/.codex/config.toml for repl.",
    "Wrote the kept value of KEY into ~/.claude.json and ~/.codex/config.toml for repl. It stays on this machine.",
    "Removed the kept value of A from ~/.claude.json for other.",
  ]);
});

test("files that share nothing each get their own notice", () => {
  expect(
    messages([
      { action: "wrote", server: "s", file: "a", variables: ["X"] },
      { action: "wrote", server: "s", file: "b", variables: ["Y"] },
    ]),
  ).toStrictEqual([
    "Wrote the kept value of X into a for s. It stays on this machine.",
    "Wrote the kept value of Y into b for s. It stays on this machine.",
  ]);
});
