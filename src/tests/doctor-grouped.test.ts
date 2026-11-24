import { expect, test } from "vitest";
import type { SyncEvent } from "../features/environment/events.js";
import {
  unsupportedChecks,
  variableChecks,
} from "../features/doctor/grouped.js";

const unset = (server: string, variable: string, from?: string): SyncEvent => ({
  type: "unset-variable",
  server,
  variable,
  ...(from ? { from } : {}),
});

const unsupported = (
  harness: "claude" | "codex",
  name: string,
  reason = "No implementation for this harness",
): SyncEvent => ({ type: "unsupported", kind: "hook", harness, name, reason });

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

test("unsupported Hooks are one check per reason, listed by tool", () => {
  const checks = unsupportedChecks([
    unsupported("codex", "stop"),
    unsupported("claude", "pre"),
    unsupported("codex", "post"),
    unsupported("codex", "needs", "Needs python3"),
    { type: "notice", message: "unrelated" },
  ]);

  expect(checks).toStrictEqual([
    {
      name: "Unsupported",
      status: "warn",
      detail:
        "No implementation for this harness, so BarnDog skips these Hooks there.",
      rows: [
        { label: "Codex", items: ["stop", "post"] },
        { label: "Claude Code", items: ["pre"] },
      ],
    },
    {
      name: "Unsupported",
      status: "warn",
      detail: "Needs python3, so BarnDog skips this Hook there.",
      rows: [{ label: "Codex", items: ["needs"] }],
    },
  ]);

  expect(unsupportedChecks([])).toStrictEqual([]);
});
