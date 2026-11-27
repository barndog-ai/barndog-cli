import { expect, test } from "vitest";
import type { SyncEvent } from "../features/environment/events.js";
import {
  cantRunChecks,
  hooksMissingTools,
  variableChecks,
} from "../features/doctor/grouped.js";
import type { HookSkip } from "../features/native/requirements.js";

const unset = (server: string, variable: string, from?: string): SyncEvent => ({
  type: "unset-variable",
  server,
  variable,
  ...(from ? { from } : {}),
});

const unsupported = (
  harness: "claude" | "codex",
  name: string,
  cause: HookSkip = { type: "no-implementation" },
): SyncEvent => ({
  type: "unsupported",
  kind: "hook",
  harness,
  name,
  cause,
  reason: "unused",
});

const needs = (command: string): HookSkip => ({
  type: "missing-requirement",
  requirement: { type: "command", command },
});

test("one variable with no value keeps its own sentence and exact fix", () => {
  expect(variableChecks([unset("web", "KEY")])).toStrictEqual([
    {
      name: "MCP variable",
      status: "warn",
      detail: expect.stringMatching(
        /^KEY has no value here, so web can't use it\. BarnDog doesn't keep it/,
      ),
      fix: "barndog mcp env set web KEY",
    },
  ]);
});

test("variables with no value are one check, listed by server", () => {
  const checks = variableChecks([
    unset("a", "ONE"),
    unset("b", "TWO"),
    unset("a", "THREE"),
    unset("a", "ONE"),
  ]);

  expect(checks).toStrictEqual([
    {
      name: "MCP variables",
      status: "warn",
      detail: expect.stringMatching(/^4 variables have no value here/),
      rows: [
        { label: "a", items: ["ONE", "THREE"] },
        { label: "b", items: ["TWO"] },
      ],
      fix: "barndog mcp env set <server> <variable>",
    },
  ]);
});

test("one server's variables point the fix at that server", () => {
  expect(variableChecks([unset("a", "ONE"), unset("a", "TWO")])[0]?.fix).toBe(
    "barndog mcp env set a",
  );
});

test("variables read from another variable are grouped apart, saying which", () => {
  const checks = variableChecks([
    unset("a", "ONE"),
    unset("a", "PAT", "GITHUB_TOKEN"),
    unset("b", "REGION", "AWS_REGION"),
    { type: "unassigned-value", variable: "STRAY" },
  ]);

  expect(checks.map((check) => check.name)).toStrictEqual([
    "MCP variable",
    "MCP variables",
    "MCP variable",
  ]);

  expect(checks[1]).toMatchObject({
    detail: expect.stringMatching(
      /^2 variables read another variable that has no value here/,
    ),
    rows: [
      { label: "a", items: ["PAT from $GITHUB_TOKEN"] },
      { label: "b", items: ["REGION from $AWS_REGION"] },
    ],
  });

  expect(checks[2]?.fix).toBe("barndog mcp env set <server> STRAY");
});

test("Hooks that can't run are one check, a row each, with the fix they share", () => {
  const checks = cantRunChecks([
    unsupported("codex", "stop"),
    unsupported("claude", "lint", needs("deno")),
    unsupported("codex", "lint", needs("deno")),
    { type: "notice", message: "unrelated" },
  ]);

  expect(checks).toStrictEqual([
    {
      name: "Hooks",
      status: "warn",
      detail: "1 Hook can't run in a tool it's written for.",
      table: [
        [
          "lint",
          "Claude Code",
          "needs the deno command, which isn't installed here or isn't on your PATH",
        ],
        [
          "lint",
          "Codex",
          "needs the deno command, which isn't installed here or isn't on your PATH",
        ],
      ],
      fix: "Install deno, then run the command below",
      command: "barndog sync",
    },
  ]);

  expect(cantRunChecks([unsupported("codex", "stop")])).toStrictEqual([]);
});

test("Hooks that need different things share a general fix", () => {
  const [check] = cantRunChecks([
    unsupported("claude", "lint", needs("deno")),
    unsupported("claude", "format", needs("prettier")),
  ]);

  expect(check?.detail).toBe(
    "2 Hooks can't run in a tool they're written for.",
  );

  expect(check?.fix).toBe(
    "Install or update what each Hook needs, then run the command below",
  );
});

test("Hooks not written for a tool are counted once each, apart from those that can't run", () => {
  expect(
    hooksMissingTools([
      unsupported("codex", "stop"),
      unsupported("codex", "post"),
      unsupported("claude", "stop"),
      unsupported("claude", "lint", needs("deno")),
    ]),
  ).toBe(2);
});
