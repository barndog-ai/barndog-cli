import { stripVTControlCharacters } from "node:util";
import checkbox from "@inquirer/checkbox";
import confirm from "@inquirer/confirm";
import { beforeEach, expect, test, vi } from "vitest";

import type { AdoptionResult } from "../features/adoption/adopt.js";
import type { NativeAsset, NativeScan } from "../features/adoption/scan.js";
import { createProgram } from "../program.js";
import {
  offerAdoption,
  offerAdoptionAtSetup,
  renderAdoption,
  renderAdoptions,
  renderScan,
  renderUndo,
} from "../ui/adopt.js";
import { testRuntime } from "./runtime.js";

vi.mock("@inquirer/checkbox", async (original) => ({
  ...(await original<typeof import("@inquirer/checkbox")>()),
  default: vi.fn(),
}));

vi.mock("@inquirer/confirm", () => ({ default: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

const runtime = testRuntime("/home/dev");

const asset = (overrides: Partial<NativeAsset>): NativeAsset => ({
  key: "claude/mcp/github",
  harness: "claude",
  kind: "mcp",
  name: "github",
  description: "GitHub",
  location: "/home/dev/.claude.json",
  sameName: [],
  identical: true,
  notes: [],
  values: [],
  ...overrides,
});

const scan: NativeScan = {
  assets: [
    asset({
      sameName: [{ key: "cursor/mcp/github", harness: "cursor" }],
      identical: false,
    }),
    asset({
      key: "cursor/mcp/github",
      harness: "cursor",
      sameName: [{ key: "claude/mcp/github", harness: "claude" }],
      identical: false,
    }),
    asset({
      key: "codex/skill/notes",
      harness: "codex",
      kind: "skill",
      name: "notes",
      sameName: [{ key: "opencode/skill/notes", harness: "opencode" }],
    }),
  ],
  skipped: [
    {
      harness: "claude",
      kind: "hook",
      name: "Stop hook",
      location: "/home/dev/.claude/settings.json",
      reason: "It runs a prompt hook.",
    },
  ],
};

const result: AdoptionResult = {
  id: "a1",
  adopted: [],
  backup: "/home/dev/.barndog/adoptions/a1",
  notes: [
    { kind: "mcp", name: "github", text: "Set TOKEN in your environment." },
  ],
  values: [],
  events: [],
  canShare: false,
};

test("the picker groups assets by tool and adopts only what's picked", async () => {
  vi.mocked(checkbox).mockResolvedValue(["claude/mcp/github"]);
  vi.mocked(confirm).mockResolvedValue(true);
  const lines: string[] = [];
  const adoptNative = vi.fn().mockResolvedValue(result);

  await offerAdoption(scan, {
    adoptNative,
    write: (line) => lines.push(line),
    runtime,
  });

  const picker = vi.mocked(checkbox).mock.calls[0]?.[0];
  const choices = (picker?.choices ?? []) as (
    { separator: string } | { value: string }
  )[];

  const names = choices.map((choice) =>
    "separator" in choice ? `[${choice.separator}]` : choice.value,
  );

  expect(names).toStrictEqual([
    "[Claude Code]",
    "claude/mcp/github",
    "[Codex]",
    "codex/skill/notes",
    "[Cursor]",
    "cursor/mcp/github",
  ]);

  expect(adoptNative).toHaveBeenCalledWith(["claude/mcp/github"], []);
  const text = lines.join("\n");
  expect(text).toMatch(/differs from Cursor/);
  expect(text).toMatch(/same as OpenCode/);
  expect(text).toMatch(/replaced by Claude Code's/);
  expect(text).toMatch(/It runs a prompt hook/);
  expect(text).toMatch(/MCP github: Set TOKEN/);
  expect(text).toMatch(/Tip: barndog local list/);
  expect(text).not.toMatch(/adopt undo/);
});

test("after adopting beside a shared workspace, the next step is sharing", () => {
  const text = renderAdoption({ ...result, canShare: true }, runtime).join(
    "\n",
  );

  expect(text).toMatch(/Tip: barndog local move/);
});

test("nothing is adopted when nothing is picked or the plan is declined", async () => {
  const adoptNative = vi.fn();
  const lines: string[] = [];
  const prompt = { adoptNative, write: (l: string) => lines.push(l), runtime };

  vi.mocked(checkbox).mockResolvedValue([]);
  await offerAdoption(scan, prompt);
  vi.mocked(checkbox).mockResolvedValue(["codex/skill/notes"]);
  vi.mocked(confirm).mockResolvedValue(false);
  await offerAdoption(scan, prompt);

  expect(adoptNative).not.toHaveBeenCalled();
  expect(lines.filter((l) => l.includes("Nothing adopted"))).toHaveLength(2);
});

test("a problem while adopting at setup is reported, not raised", async () => {
  const lines: string[] = [];
  // No settings in this home, so the scan refuses.
  await offerAdoptionAtSetup(testRuntime("/nonexistent-home"), {
    write: (line) => lines.push(line),
  });

  expect(lines.join("\n")).toMatch(/Nothing was adopted[\s\S]*barndog adopt/);
});

test("adoption output covers empty and partial results", () => {
  expect(
    stripVTControlCharacters(
      renderScan({ assets: [], skipped: [] }, runtime).join("\n"),
    ),
  ).toBe(
    "✔ Nothing left to adopt: BarnDog manages every Skill, MCP server and Hook it can take over from your coding tools.",
  );

  // What's left is only what can't be adopted, so that follows the explanation.
  const leftovers = stripVTControlCharacters(
    renderScan({ assets: [], skipped: scan.skipped }, runtime).join("\n"),
  );

  expect(leftovers).toMatch(
    /^✔ Nothing left to adopt[^\n]*\n\nCan't be adopted\n {2}Claude Code Hook Stop hook[^\n]*\n {4}It runs a prompt hook\./,
  );

  expect(renderAdoptions([]).join("\n")).toMatch(/Nothing has been adopted/);
  const item = {
    key: "claude/mcp/github",
    harness: "claude" as const,
    kind: "mcp" as const,
    name: "github",
    description: "",
    location: "/home/dev/.claude.json",
    copy: "/w/org/mcp/github.yaml",
    undone: true,
  };

  const undo = renderUndo(
    { id: "a1", restored: [item], remaining: [{ ...item, undone: false }] },
    runtime,
  ).join("\n");

  expect(undo).toMatch(/~[\\/]\.claude\.json/);
  expect(undo).toMatch(/1 asset of this adoption is still managed/);
  expect(
    renderAdoptions([
      {
        id: "a1",
        createdAt: "2026-11-18T10:00:00.000Z",
        status: "pending",
        items: [item],
      },
    ]).join("\n"),
  ).toMatch(/2026-11-18[\s\S]*pending/);
});

test("adopt in a terminal opens the picker, and reports when there's nothing", async () => {
  const lines: string[] = [];
  const adoptNative = vi.fn().mockResolvedValue(result);
  vi.mocked(checkbox).mockResolvedValue(["codex/skill/notes"]);
  vi.mocked(confirm).mockResolvedValue(true);

  const program = (found: NativeScan) =>
    createProgram({
      interactive: true,
      write: (line) => lines.push(line),
      scanNative: async () => found,
      adoptNative,
    });

  await program(scan).parseAsync(["adopt"], { from: "user" });
  expect(adoptNative).toHaveBeenCalledWith(["codex/skill/notes"], []);

  const empty = { assets: [], skipped: [] };
  await program(empty).parseAsync(["adopt"], { from: "user" });
  await program(empty).parseAsync(["adopt", "--all"], { from: "user" });
  await program(empty).parseAsync(["adopt", "--all", "--json"], {
    from: "user",
  });

  expect(lines).toContain("Nothing to adopt.");
  expect(lines.some((line) => line.includes('"adopted": []'))).toBe(true);
  expect(lines.join("\n")).toMatch(/Nothing left to adopt/);
});

test("adopting asks once per value which ones BarnDog keeps, and passes the answer on", async () => {
  vi.mocked(checkbox)
    .mockResolvedValueOnce(["claude/mcp/github"])
    .mockResolvedValueOnce([{ server: "github", variable: "TOKEN" }]);

  vi.mocked(confirm).mockResolvedValue(true);
  const lines: string[] = [];
  const adoptNative = vi.fn().mockResolvedValue(result);
  const valued: NativeScan = {
    ...scan,
    assets: scan.assets.map((item) =>
      item.kind === "mcp"
        ? { ...item, values: [{ key: "TOKEN", variable: "TOKEN" }] }
        : item,
    ),
  };

  await offerAdoption(valued, {
    adoptNative,
    write: (line) => lines.push(line),
    runtime,
  });

  // Cursor's github comes along but shares claude's source, so TOKEN is asked once.
  const asked = vi.mocked(checkbox).mock.calls[1]![0];
  expect(asked.message).toBe(
    "Which values should BarnDog keep on this machine?",
  );

  expect(asked.choices).toStrictEqual([
    expect.objectContaining({
      value: { server: "github", variable: "TOKEN" },
      checked: true,
    }),
  ]);

  expect(lines.join("\n")).toMatch(/never uploaded/);
  expect(adoptNative).toHaveBeenCalledWith(
    ["claude/mcp/github"],
    [{ server: "github", variable: "TOKEN" }],
  );
});
