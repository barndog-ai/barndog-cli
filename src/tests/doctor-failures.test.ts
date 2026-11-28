import { beforeEach, expect, test, vi } from "vitest";
import { doctor } from "../features/doctor/index.js";
import { detectHarnesses } from "../harnesses/detect.js";
import { remoteHead } from "../features/workspace/git.js";
import { branchProtected } from "../features/workspace/publish.js";
import { readFetchState } from "../features/workspace/repo-source.js";
import { synchronize } from "../features/environment/sync.js";
import { authStatus } from "../features/auth/session.js";
import { LoginRequiredError } from "../features/auth/transport.js";
import { CliError } from "../errors.js";
import { saveSettings } from "../config/settings.js";
import { cloud, ID } from "./cloud.js";
import { testRuntime } from "./runtime.js";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { barndogPaths } from "../config/paths.js";

vi.mock("../harnesses/detect.js", () => ({ detectHarnesses: vi.fn() }));
vi.mock("../features/workspace/git.js", async (original) => ({
  ...(await original<typeof import("../features/workspace/git.js")>()),
  remoteHead: vi.fn(),
}));

vi.mock("../features/workspace/publish.js", async (original) => ({
  ...(await original<typeof import("../features/workspace/publish.js")>()),
  branchProtected: vi.fn(),
}));

vi.mock("../features/workspace/repo-source.js", async (original) => ({
  ...(await original<typeof import("../features/workspace/repo-source.js")>()),
  readFetchState: vi.fn(),
}));

// Sync and the session check run for real against the fake server; the spies
// only let a test see whether they ran, or stand in for a Git host.
vi.mock("../features/environment/sync.js", async (original) => {
  const actual =
    await original<typeof import("../features/environment/sync.js")>();

  return { ...actual, synchronize: vi.fn(actual.synchronize) };
});

vi.mock("../features/auth/session.js", async (original) => {
  const actual = await original<typeof import("../features/auth/session.js")>();

  return { ...actual, authStatus: vi.fn(actual.authStatus) };
});

const actualSync = (
  await vi.importActual<typeof import("../features/environment/sync.js")>(
    "../features/environment/sync.js",
  )
).synchronize;

const actualAuthStatus = (
  await vi.importActual<typeof import("../features/auth/session.js")>(
    "../features/auth/session.js",
  )
).authStatus;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(detectHarnesses).mockResolvedValue([]);
  vi.mocked(remoteHead).mockResolvedValue(null);
  vi.mocked(readFetchState).mockResolvedValue({});
  vi.mocked(synchronize).mockImplementation(actualSync);
  vi.mocked(authStatus).mockImplementation(actualAuthStatus);
});

for (const protection of [true, false, null]) {
  for (const fetched of [false, true]) {
    test(`git diagnostics describe fetch history and branch protection (${protection}/${fetched})`, async (t) => {
      const server = await cloud(t);
      await saveSettings(
        {
          harnesses: ["claude"],
          gitWorkspace: {
            url: "https://example.test/repo",
            branch: "main",
            workspaceId: ID,
          },
        },
        server.home,
      );

      // There's no Git host to sync from; the Git checks are what's under test.
      vi.mocked(synchronize).mockResolvedValue([]);
      vi.mocked(branchProtected).mockResolvedValue(protection);
      vi.mocked(readFetchState).mockResolvedValue(
        fetched ? { fetchedAt: "2026-01-01T00:00:00Z" } : {},
      );

      const checks = (await doctor(testRuntime(server.home))).checks;
      expect(checks.find((check) => check.name === "Last fetch")!.status).toBe(
        fetched ? "ok" : "warn",
      );

      expect(checks.some((check) => check.name === "Branch protection")).toBe(
        protection !== true,
      );

      expect(checks.some((check) => check.name === "Installation")).toBe(true);
    });
  }
}

for (const [situation, error, expected] of [
  [
    "signed out",
    new LoginRequiredError(),
    { detail: "Not signed in.", fix: "barndog login" },
  ],
  [
    "server unreachable",
    new CliError("Can't reach the BarnDog server.", "barndog doctor"),
    { detail: "Can't reach the BarnDog server.", fix: "barndog doctor" },
  ],
  [
    "broken server contract",
    new Error("The server sent an invalid context"),
    { detail: "The server sent an invalid context", fix: undefined },
  ],
] as const) {
  test(`a session that is ${situation} fails with its reason and fix, and later checks are skipped`, async (t) => {
    const server = await cloud(t);
    vi.mocked(authStatus).mockRejectedValue(error);
    const checks = (await doctor(testRuntime(server.home))).checks;
    expect(checks.find((check) => check.name === "Session")).toEqual({
      name: "Session",
      status: "fail",
      ...expected,
    });

    expect(checks.map((check) => check.name)).not.toContain("Installation");
    expect(synchronize).not.toHaveBeenCalled();
  });
}

test("failed git access is reported while installation checks still run", async (t) => {
  const server = await cloud(t);
  await saveSettings(
    {
      harnesses: [],
      gitWorkspace: {
        url: "https://example.test/repo",
        branch: "main",
        workspaceId: ID,
      },
    },
    server.home,
  );

  vi.mocked(remoteHead).mockRejectedValue(new CliError("denied", "git clone"));
  vi.mocked(readFetchState).mockResolvedValue({
    fetchedAt: new Date(0).toISOString(),
  });

  vi.mocked(synchronize).mockRejectedValue(
    new CliError(
      "~/.claude/skills/review isn't managed by BarnDog.",
      "barndog doctor",
      { command: "rm -rf ~/.claude/skills/review" },
    ),
  );

  expect((await doctor(testRuntime(server.home))).checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "Git access",
        status: "fail",
        fix: "git clone",
      }),
      // Read from this machine, so it still shows while the host is down.
      expect.objectContaining({ name: "Last fetch", status: "ok" }),
      expect.objectContaining({
        name: "Installation",
        status: "fail",
        detail: "~/.claude/skills/review isn't managed by BarnDog.",
        fix: "barndog doctor",
        command: "rm -rf ~/.claude/skills/review",
      }),
    ]),
  );

  expect(branchProtected).not.toHaveBeenCalled();
});

test("a selected coding tool that isn't on this machine is fixed by installing it or disabling it", async (t) => {
  const server = await cloud(t, { harnesses: ["claude", "opencode"] });
  vi.mocked(detectHarnesses).mockResolvedValue([
    { id: "claude", name: "Claude Code", evidence: "claude on PATH" },
  ]);

  const checks = (await doctor(testRuntime(server.home))).checks;
  expect(checks).toEqual(
    expect.arrayContaining([
      { name: "Claude Code", status: "ok", detail: "claude on PATH" },
      {
        name: "OpenCode",
        status: "warn",
        detail: "Not found on this machine; assets are still installed for it.",
        fix: "Install OpenCode, or stop BarnDog installing for it.",
        command: "barndog harnesses disable opencode",
      },
    ]),
  );
});

const installation = async (home: string) =>
  (await doctor(testRuntime(home))).checks.find(
    (check) => check.name === "Installation",
  );

test("a selected Skill that isn't installed yet is a pending change, fixed by barndog sync", async (t) => {
  const server = await cloud(t, {
    harnesses: ["claude"],
    environment: {
      subscriptions: [],
      individualAssetIds: [ID],
      excludedAssetIds: [],
      disabledAssetIds: [],
    },
  });

  // The Skill plus BarnDog's own session-start entries in the coding tool.
  expect(await installation(server.home)).toEqual({
    name: "Installation",
    status: "warn",
    detail: expect.stringMatching(/^\d+ pending changes?$/),
    fix: "barndog sync",
  });

  await expect(
    access(join(server.home, ".claude/skills/release-notes")),
  ).rejects.toMatchObject({ code: "ENOENT" });

  await server.run(["sync"]);

  expect(await installation(server.home)).toEqual({
    name: "Installation",
    status: "ok",
    detail: "Everything selected is installed and up to date.",
    fix: undefined,
  });
});

test("an installed Skill edited by hand fails the installation check without being touched", async (t) => {
  const server = await cloud(t, {
    harnesses: ["claude"],
    environment: {
      subscriptions: [],
      individualAssetIds: [ID],
      excludedAssetIds: [],
      disabledAssetIds: [],
    },
  });

  await server.run(["sync"]);
  const file = join(
    barndogPaths(server.home).installed("skill"),
    "release-notes",
    "SKILL.md",
  );

  const edited = (await readFile(file, "utf8")) + "\nHand edit\n";
  await writeFile(file, edited);

  const check = await installation(server.home);

  expect(check).toMatchObject({ name: "Installation", status: "fail" });
  expect(check?.detail).toContain("release-notes");
  expect(check?.fix).toEqual(expect.stringMatching(/\S/));
  expect(await readFile(file, "utf8")).toBe(edited);
});
