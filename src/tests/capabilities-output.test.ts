import { stripVTControlCharacters } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import open from "open";
import { createProgram } from "../program.js";
import { CliError } from "../errors.js";
import type { RepositoryStatus } from "../features/inspection/index.js";
import type { Check } from "../features/doctor/check.js";
import type { SetsList } from "../features/environment/operations.js";

vi.mock("open", () => ({ default: vi.fn() }));
const exitCode = process.exitCode;
afterEach(() => {
  process.exitCode = exitCode;
  vi.resetAllMocks();
});

async function doctorOutput(checks: Check[]) {
  const write = vi.fn();
  await createProgram({ write, doctor: async () => checks }).parseAsync(
    ["doctor"],
    { from: "user" },
  );

  return write.mock.calls.flat().join("\n").split("\n");
}

const passing: Check = { name: "Session", status: "ok", detail: "Signed in" };
const warning: Check = {
  name: "Git access",
  status: "warn",
  detail: "Not fetched yet",
  fix: "barndog sync",
};

const failing: Check = {
  name: "Installation",
  status: "fail",
  detail: "Two clashes",
  fix: "barndog doctor",
};

for (const [situation, checks, summary, exit] of [
  ["all pass", [passing], "✔ Everything looks good.", exitCode],
  ["one warning", [passing, warning], "! 1 warning.", exitCode],
  ["two warnings", [warning, warning], "! 2 warnings.", exitCode],
  ["one failure", [passing, failing], "✖ 1 problem found.", 1],
  [
    "failures and warnings",
    [failing, warning, failing],
    "✖ 2 problems found.",
    1,
  ],
] as const) {
  test(`doctor with ${situation} ends with "${summary}" and exit code ${exit}`, async () => {
    const lines = await doctorOutput([...checks]);

    expect(lines.at(-1)).toBe(summary);
    expect(process.exitCode).toBe(exit);
  });
}

test("doctor shows each check with its mark, detail and fix", async () => {
  const lines = await doctorOutput([passing, warning, failing]);

  expect(lines).toEqual(
    expect.arrayContaining([
      "✔ Session       Signed in",
      "! Git access    Not fetched yet",
      "✖ Installation  Two clashes",
    ]),
  );

  const fixes = lines.filter((line) => line.includes("Fix:"));
  expect(fixes.map((line) => line.trim())).toEqual([
    "Fix: barndog sync",
    "Fix: barndog doctor",
  ]);
});

test("doctor lists a grouped check's names under its detail, aligned by label", async () => {
  const lines = await doctorOutput([
    passing,
    {
      name: "MCP variables",
      status: "warn",
      detail: "3 variables have no value here.",
      rows: [
        { label: "web", items: ["KEY"] },
        { label: "tickets", items: ["REGION", "HOME"] },
      ],
      fix: "barndog mcp env set <server> <variable>",
    },
  ]);

  expect(lines.map(stripVTControlCharacters)).toEqual(
    expect.arrayContaining([
      "! MCP variables  3 variables have no value here.",
      "                 web      KEY",
      "                 tickets  REGION, HOME",
      "                 Fix: barndog mcp env set <server> <variable>",
    ]),
  );
});

test("doctor --json prints the checks as they are", async () => {
  const write = vi.fn();
  const checks = [passing, failing];
  await createProgram({ write, doctor: async () => checks }).parseAsync(
    ["doctor", "--json"],
    { from: "user" },
  );

  expect(JSON.parse(write.mock.lastCall![0])).toEqual(checks);
});

const app = { id: "repo", name: "App", slug: "app" };
const web = { id: "team", name: "Web", slug: "web" };

function status(overrides: Partial<RepositoryStatus>): RepositoryStatus {
  return {
    root: "/project",
    remotes: ["github.test/acme/app"],
    repository: null,
    team: null,
    ambiguous: false,
    policyScopes: [],
    ...overrides,
  };
}

const subscribedTo = (ids: string[]): SetsList => ({
  available: [],
  subscriptions: ids.map((id) => ({
    scope: { type: "repo", id },
    mode: "all",
    enabled: true,
  })),
  diagnostics: [],
});

async function repoOutput(
  result: RepositoryStatus,
  listSets: () => Promise<SetsList> = async () => subscribedTo([]),
) {
  const write = vi.fn();
  await createProgram({
    write,
    repoStatus: async () => result,
    listSets,
  }).parseAsync(["repo", "status"], { from: "user" });

  return write.mock.calls.flat().join("\n").split("\n");
}

const field = (lines: string[], name: string) =>
  lines
    .find((line) => line.trimStart().startsWith(name))
    ?.trim()
    .slice(name.length)
    .trim();

test("outside a Git repository, repo status says so and how to get into one", async () => {
  const lines = await repoOutput(status({ root: null }));

  expect(lines[0]).toBe("Not inside a Git repository.");
  expect(stripVTControlCharacters(lines.join("\n"))).toContain(
    "run barndog repo status from inside your repository",
  );
});

test("an unregistered repository says an admin can register it, and offers no install", async () => {
  const lines = await repoOutput(status({ remotes: [] }));

  expect(field(lines, "Folder")).toBe("/project");
  expect(field(lines, "Remotes")).toBe("none");
  expect(field(lines, "Repository")).toBe("not registered in BarnDog");
  expect(field(lines, "Subscribed")).toBeUndefined();
  expect(lines).toContain(
    "An admin can register this repository in the BarnDog workspace.",
  );

  expect(lines.join("\n")).not.toContain("sets install");
});

test("a repository matching several BarnDog repositories says so, without the register note", async () => {
  const lines = await repoOutput(status({ ambiguous: true }));

  expect(field(lines, "Repository")).toBe(
    "matches several BarnDog repositories",
  );

  expect(lines.join("\n")).not.toContain("An admin can register");
});

test("a registered repository you're not subscribed to shows its team and how to subscribe", async () => {
  const lines = await repoOutput(status({ repository: app, team: web }));

  expect(field(lines, "Repository")).toBe("App repo/app");
  expect(field(lines, "Owning team")).toBe("Web team/web");
  expect(field(lines, "Subscribed")).toBe("no");
  expect(lines.join("\n")).toContain("barndog sets install repo/app");
});

test("a registered repository you're subscribed to says yes and offers no install", async () => {
  const lines = await repoOutput(status({ repository: app }), async () =>
    subscribedTo(["repo"]),
  );

  expect(field(lines, "Subscribed")).toBe("yes");
  expect(lines.join("\n")).not.toContain("sets install");
});

test("when your subscriptions can't be read, repo status reports that error instead of saying you aren't subscribed", async () => {
  const failure = new CliError(
    "Can't reach the BarnDog server.",
    "barndog doctor",
  );

  const write = vi.fn();
  const error: unknown = await createProgram({
    write,
    repoStatus: async () => status({ repository: app }),
    listSets: async () => {
      throw failure;
    },
  })
    .parseAsync(["repo"], { from: "user" })
    .catch((caught: unknown) => caught);

  expect(error).toBe(failure);
  expect(write.mock.calls.flat().join("\n")).not.toContain("Subscribed");
});

test("open opens the workspace in a browser and says so", async () => {
  const write = vi.fn();
  vi.mocked(open).mockResolvedValue({} as never);
  await createProgram({
    write,
    workspaceUrl: async () => "https://example.test",
  }).parseAsync(["open"], { from: "user" });

  expect(open).toHaveBeenCalledWith("https://example.test");
  expect(write).toHaveBeenLastCalledWith(
    "✔ Opened https://example.test in your browser.",
  );
});

test("open prints the address when no browser can be opened", async () => {
  const write = vi.fn();
  vi.mocked(open).mockRejectedValue(new Error("no browser"));
  await createProgram({
    write,
    workspaceUrl: async () => "https://example.test",
  }).parseAsync(["open"], { from: "user" });

  expect(write).toHaveBeenLastCalledWith(
    "Couldn't open a browser. Visit https://example.test",
  );
});

test("open --no-browser and --json print the address without opening anything", async () => {
  const write = vi.fn();
  await createProgram({
    write,
    workspaceUrl: async () => "https://example.test",
  }).parseAsync(["open", "--no-browser"], { from: "user" });

  expect(write).toHaveBeenLastCalledWith("https://example.test");

  await createProgram({
    write,
    workspaceUrl: async () => "https://example.test",
  }).parseAsync(["open", "--json"], { from: "user" });

  expect(JSON.parse(write.mock.lastCall![0])).toEqual({
    url: "https://example.test",
  });

  expect(open).not.toHaveBeenCalled();
});
