import { expect, test } from "vitest";
import {
  keptValueEvents,
  type KeptValueWrite,
} from "../features/environment/kept-value-events.js";

const write = (
  action: KeptValueWrite["action"],
  server: string,
  file: string,
  variables: string[],
): KeptValueWrite => ({ action, server, file, variables });

test("variables every file shares go in one event; each file keeps only its own", () => {
  expect(
    keptValueEvents([
      write("removed", "repl", "/h/.claude.json", ["A", "B", "C"]),
      write("removed", "repl", "/h/.codex/config.toml", ["A", "B", "D"]),
      write("wrote", "repl", "/h/.claude.json", ["KEY"]),
      write("wrote", "repl", "/h/.codex/config.toml", ["KEY"]),
      write("wrote", "repl", "/h/.cursor/mcp.json", []),
      write("removed", "other", "/h/.claude.json", ["A"]),
    ]),
  ).toStrictEqual([
    {
      type: "kept-values",
      action: "removed",
      server: "repl",
      variables: ["A", "B"],
      files: ["/h/.claude.json", "/h/.codex/config.toml"],
    },
    {
      type: "kept-values",
      action: "removed",
      server: "repl",
      variables: ["C"],
      files: ["/h/.claude.json"],
    },
    {
      type: "kept-values",
      action: "removed",
      server: "repl",
      variables: ["D"],
      files: ["/h/.codex/config.toml"],
    },
    {
      type: "kept-values",
      action: "wrote",
      server: "repl",
      variables: ["KEY"],
      files: ["/h/.claude.json", "/h/.codex/config.toml"],
    },
    {
      type: "kept-values",
      action: "removed",
      server: "other",
      variables: ["A"],
      files: ["/h/.claude.json"],
    },
  ]);
});

test("files that share nothing each get their own event", () => {
  expect(
    keptValueEvents([
      write("wrote", "s", "/a", ["X"]),
      write("wrote", "s", "/b", ["Y"]),
    ]),
  ).toStrictEqual([
    {
      type: "kept-values",
      action: "wrote",
      server: "s",
      variables: ["X"],
      files: ["/a"],
    },
    {
      type: "kept-values",
      action: "wrote",
      server: "s",
      variables: ["Y"],
      files: ["/b"],
    },
  ]);
});
