import { stripVTControlCharacters } from "node:util";
import checkbox from "@inquirer/checkbox";
import confirm from "@inquirer/confirm";
import select from "@inquirer/select";
import { beforeEach, expect, test, vi } from "vitest";

import type { AdoptedAsset } from "../features/adoption/record.js";
import type { UninstallResult } from "../features/uninstall/index.js";
import type { UninstallSurvey } from "../features/uninstall/survey.js";
import { createProgram } from "../program.js";
import {
  askUninstall,
  renderUninstall,
  renderUninstallPlan,
} from "../ui/uninstall.js";
import { testRuntime } from "./runtime.js";

vi.mock("@inquirer/checkbox", async (original) => ({
  ...(await original<typeof import("@inquirer/checkbox")>()),
  default: vi.fn(),
}));

vi.mock("@inquirer/confirm", () => ({ default: vi.fn() }));
vi.mock("@inquirer/select", () => ({ default: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

// The fixtures are POSIX paths, so the paths are displayed as on Linux.
const runtime = testRuntime("/home/dev", { platform: "linux" });
const text = (lines: string[]) => stripVTControlCharacters(lines.join("\n"));

const adopted = (key: string): AdoptedAsset => {
  const [harness, kind, name] = key.split("/");

  return {
    key,
    harness: harness as AdoptedAsset["harness"],
    kind: kind as AdoptedAsset["kind"],
    name: String(name),
    description: "",
    location: "/home/dev/.claude.json",
    copy: `/home/dev/.barndog/workspace/${String(name)}`,
    undone: false,
  };
};

const survey: UninstallSurvey = {
  root: "/home/dev/.barndog",
  installed: [
    { kind: "skill", name: "notes", harness: "claude" },
    { kind: "skill", name: "notes", harness: "codex" },
    { kind: "mcp", name: "github", harness: "claude" },
  ],
  adopted: [adopted("claude/mcp/github"), adopted("codex/skill/notes")],
  workspace: "/home/dev/.barndog/workspace",
  servers: ["https://barndog.dev"],
  variables: [{ name: "GITHUB_TOKEN", servers: ["github"] }],
};

test("askUninstall asks only what the command line left open", async () => {
  vi.mocked(select).mockResolvedValueOnce(false);
  vi.mocked(checkbox).mockResolvedValueOnce(["codex/skill/notes"]);
  vi.mocked(confirm).mockResolvedValueOnce(false);

  expect(await askUninstall(survey, {}, runtime)).toStrictEqual({
    keepSetup: false,
    restore: ["codex/skill/notes"],
    keepWorkspace: false,
    force: undefined,
  });

  expect(vi.mocked(select).mock.calls[0]?.[0].message).toContain(
    "2 Skills and 1 MCP server",
  );

  vi.resetAllMocks();
  expect(
    await askUninstall(
      { ...survey, installed: [], workspace: undefined },
      { keepSetup: true, force: true },
      runtime,
    ),
  ).toStrictEqual({
    keepSetup: true,
    restore: [],
    keepWorkspace: true,
    force: true,
  });

  expect(select).not.toHaveBeenCalled();
  expect(checkbox).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
});

test("the plan says what stays, what goes back and what is deleted for good", () => {
  const removing = text(
    renderUninstallPlan(
      survey,
      {
        keepSetup: false,
        restore: ["claude/mcp/github"],
        keepWorkspace: true,
      },
      runtime,
    ),
  );

  expect(removing).toContain("remove 2 Skills and 1 MCP server");
  expect(removing).toContain(
    "remove its own scripts and registrations from your tools",
  );

  expect(removing).not.toMatch(/session-start|knowledge index/);
  expect(removing).toContain("put back 1 adopted asset where it came from");
  expect(removing).toContain(
    "delete 1 adopted asset for good: codex/skill/notes",
  );

  expect(removing).toContain("sign out of https://barndog.dev");
  expect(removing).toContain("except your local workspace");

  const keeping = text(
    renderUninstallPlan(
      {
        ...survey,
        adopted: [],
        servers: [],
        workspace: undefined,
      },
      { keepSetup: true, restore: [], keepWorkspace: true },
      runtime,
    ),
  );

  expect(keeping).toContain("leave 2 Skills and 1 MCP server");
  expect(keeping).toMatch(
    /keep these variables set[^\n]*\n +Variable +MCP servers\n +GITHUB_TOKEN +github/,
  );

  expect(removing).not.toContain("GITHUB_TOKEN");
  expect(keeping).toMatch(/delete ~\/\.barndog$/);
  expect(keeping).not.toContain("sign out");
});

test("the result lists what was left, put back and signed out, then the last step", () => {
  const result: UninstallResult = {
    keptSetup: true,
    left: [
      {
        kind: "hook",
        name: "check",
        harness: "claude",
        path: "/home/dev/.claude/hooks/check",
      },
    ],
    variables: [{ name: "GITHUB_TOKEN", servers: ["github", "docs"] }],
    removed: [
      {
        type: "native",
        action: "removed",
        kind: "sync",
        harness: "claude",
        name: "sync",
      },
    ],
    restored: [adopted("claude/mcp/github")],
    signedOut: [
      { server: "https://a.example", revoked: true },
      { server: "https://b.example", revoked: false },
    ],
    root: "/home/dev/.barndog",
    keptWorkspace: "/home/dev/.barndog/workspace",
  };

  const output = text(renderUninstall(result, runtime));
  expect(output).toContain("~/.claude/hooks/check");
  expect(output).toMatch(
    /keeping them set is up to you:\n +Variable +MCP servers\n +GITHUB_TOKEN +github, docs/,
  );

  expect(output).toContain(
    "Removed BarnDog's own scripts and registrations from your coding tools.",
  );

  expect(output).toContain("Put back claude/mcp/github.");
  expect(output).toContain("Signed out of https://a.example.");
  expect(output).toContain("couldn't be told");
  expect(output).toContain("except your local workspace");
  expect(output).toContain("npm uninstall -g barndog");
});

test("in a terminal, uninstall shows the plan and stops unless confirmed", async () => {
  const calls: unknown[] = [];
  const output: string[] = [];
  const program = () =>
    createProgram({
      interactive: true,
      write: (line) => output.push(line),
      uninstallSurvey: async () => ({ ...survey, adopted: [] }),
      uninstall: async (options) => {
        calls.push(options);

        return {
          keptSetup: true,
          left: [],
          removed: [],
          variables: [],
          restored: [],
          signedOut: [],
          root: survey.root,
        };
      },
    });

  vi.mocked(confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await program().parseAsync(["uninstall", "--keep-setup"], { from: "user" });
  expect(calls).toStrictEqual([]);
  expect(text(output)).toContain("Nothing was changed.");

  vi.mocked(confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
  await program().parseAsync(["uninstall", "--keep-setup"], { from: "user" });
  expect(calls).toHaveLength(1);
  expect(text(output)).toContain("BarnDog's files are gone");
});
