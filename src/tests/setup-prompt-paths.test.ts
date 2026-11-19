import { beforeEach, expect, test, vi, type TestContext } from "vitest";
import checkbox from "@inquirer/checkbox";
import confirm from "@inquirer/confirm";
import { contextSchema } from "@barndog-ai/api-contract";
import { runSetup } from "../ui/onboarding.js";
import { initialize } from "../features/onboarding/setup.js";
import { synchronize } from "../features/environment/sync.js";
import {
  inspectRepository,
  connectGitWorkspace,
  createGitWorkspace,
  cloneGitWorkspace,
  localWorkspace,
} from "../features/workspace/setup.js";
import {
  cloneOrigin,
  RepositoryAccessError,
} from "../features/workspace/git.js";
import { authStatus } from "../features/auth/session.js";
import { runLogin } from "../ui/auth.js";
import { CliError } from "../errors.js";
import { barndogPaths } from "../config/paths.js";
import { LoginRequiredError } from "../features/auth/transport.js";
import {
  saveSettings,
  readSettings,
  type Settings,
} from "../config/settings.js";
import type { EnvironmentChoices } from "../features/onboarding/environment.js";
import {
  moveLocalAssets,
  cloudMoveTargets,
} from "../features/migration/move.js";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cloud, ID } from "./cloud.js";
import { sample } from "./sample.js";
import { testRuntime } from "./runtime.js";

vi.mock("@inquirer/checkbox", () => ({ default: vi.fn() }));
vi.mock("@inquirer/confirm", () => ({ default: vi.fn() }));
vi.mock("../features/onboarding/setup.js", async (original) => ({
  ...(await original<typeof import("../features/onboarding/setup.js")>()),
  initialize: vi.fn(),
}));

vi.mock("../features/environment/sync.js", () => ({
  synchronize: vi.fn().mockResolvedValue([]),
}));

vi.mock("../features/workspace/setup.js", async (original) => ({
  ...(await original<typeof import("../features/workspace/setup.js")>()),
  inspectRepository: vi.fn(),
  connectGitWorkspace: vi.fn(),
  createGitWorkspace: vi.fn(),
  cloneGitWorkspace: vi.fn(),
}));

vi.mock("../features/workspace/git.js", async (original) => ({
  ...(await original<typeof import("../features/workspace/git.js")>()),
  cloneOrigin: vi.fn(),
}));

vi.mock("../features/auth/session.js", async (original) => ({
  ...(await original<typeof import("../features/auth/session.js")>()),
  authStatus: vi.fn(),
}));

vi.mock("../ui/auth.js", async (original) => ({
  ...(await original<typeof import("../ui/auth.js")>()),
  runLogin: vi.fn(),
}));

vi.mock("../features/migration/move.js", async (original) => ({
  ...(await original<typeof import("../features/migration/move.js")>()),
  moveLocalAssets: vi.fn(),
  cloudMoveTargets: vi.fn(),
}));

const git = {
  url: "https://example.test/repo.git",
  branch: "main",
  workspaceId: ID,
};

const emptySelection = {
  subscriptions: [],
  individualAssetIds: [],
  excludedAssetIds: [],
  disabledAssetIds: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(confirm).mockResolvedValue(true);
  vi.mocked(checkbox).mockResolvedValue(["claude"]);
  vi.mocked(synchronize).mockResolvedValue([]);
  vi.mocked(cloneOrigin).mockImplementation(async (url) => url);
  vi.mocked(authStatus).mockResolvedValue({
    server: "http://127.0.0.1:9",
    context: sample(contextSchema),
  });

  vi.mocked(connectGitWorkspace).mockResolvedValue(git);
  vi.mocked(createGitWorkspace).mockResolvedValue(git);
  vi.mocked(cloneGitWorkspace).mockResolvedValue(git);
});

type ReviewMode = "local" | "cloud" | "git";

/** Runs setup far enough to show the review screen and returns what it printed. */
async function reviewScreen(
  t: TestContext,
  mode: ReviewMode,
  populated: boolean,
) {
  const server = await cloud(t);
  const write = vi.fn();
  vi.mocked(inspectRepository).mockResolvedValue({
    branch: "main",
    commit: "a".repeat(40),
  });

  const choices: EnvironmentChoices = {
    scopes: [
      { type: "org", id: ID, name: "Acme", slug: "acme", canPublish: true },
    ],
    catalog: {
      assets: [
        {
          id: ID,
          kind: "skill",
          name: "review",
          publishedVersion: ID,
          origin: { type: "org", id: ID, slug: "acme" },
        },
      ],
      distributions: [],
    },
    memberTeamIds: [],
    developerId: ID,
    firstSetup: true,
    previous: emptySelection,
  };

  const reviewed: { text: string }[] = [];
  vi.mocked(initialize).mockImplementation(async (options) => {
    await options.chooseEnvironment!(choices);
    const settings: Settings = {
      harnesses: populated ? ["claude", "codex"] : [],
      ...(mode === "cloud"
        ? {
            connection: {
              server: "http://127.0.0.1:9",
              organizationId: ID,
              developerId: ID,
            },
          }
        : {}),
      ...(mode === "git" ? { gitWorkspace: git } : {}),
      ...(mode === "local"
        ? { localWorkspace: { path: "/fixture/local", workspaceId: ID } }
        : {}),
      environment: {
        ...emptySelection,
        subscriptions: populated
          ? [
              { scope: { type: "org", id: ID }, mode: "all", enabled: true },
              {
                scope: { type: "team", id: "unknown" },
                mode: "recommended",
                enabled: true,
              },
            ]
          : [],
        individualAssetIds: populated ? [ID, "unknown"] : [],
      },
    };

    const before = write.mock.calls.length;
    await options.confirm!(settings);
    reviewed.push({
      text: write.mock.calls
        .slice(before)
        .map((call) => String(call[0]))
        .join("\n"),
    });

    await options.apply!(settings);

    return { configPath: "fixture-config", harnesses: settings.harnesses };
  });

  await runSetup({
    runtime: testRuntime(server.home),
    restart: true,
    interactive: true,
    write,
    chooseConnection: async () => {
      if (mode === "git") {
        return { kind: "git", url: git.url };
      }

      return mode === "cloud"
        ? { kind: "cloud", server: "http://127.0.0.1:9" }
        : { kind: "local" };
    },
    chooseEnvironment: async () => emptySelection,
  });

  return {
    review: reviewed[0]!.text,
    output: write.mock.calls.flat().join("\n"),
  };
}

const REVIEW_HEADER = "\nReview setup (applies to this whole machine)\n";
const SAVE_PROMPT = "Save and install this environment?";

function lastConfirmMessage() {
  return vi.mocked(confirm).mock.calls.at(-1)?.[0].message;
}

const populatedSelections = [
  "Scope sets (2)",
  "  Scope         Name  Mode",
  "  org           Acme  all",
  "  team/unknown        recommended",
  "",
  "Individual assets (2)",
  "  Name     Kind   Origin",
  "  review   skill  org",
  "  unknown",
  "",
];

test("cloud review lists tools, server, subscriptions and individual assets", async (t) => {
  const { review, output } = await reviewScreen(t, "cloud", true);

  expect(review).toBe(
    [
      REVIEW_HEADER,
      "Coding tools  claude, codex",
      "Workspace     http://127.0.0.1:9",
      "",
      ...populatedSelections,
    ].join("\n"),
  );

  expect(lastConfirmMessage()).toBe(SAVE_PROMPT);
  expect(output).toContain("Saved to fixture-config");
  expect(synchronize).toHaveBeenCalledTimes(1);
});

test("an empty cloud review says no tools and no selections", async (t) => {
  const { review } = await reviewScreen(t, "cloud", false);

  expect(review).toBe(
    [
      REVIEW_HEADER,
      "Coding tools  none",
      "Workspace     http://127.0.0.1:9",
      "",
      "Scope sets (0)",
      "  None.",
      "",
      "Individual assets (0)",
      "  None.",
      "",
    ].join("\n"),
  );
});

test("git review shows the repository and the same selections", async (t) => {
  const { review } = await reviewScreen(t, "git", true);

  expect(review).toBe(
    [
      REVIEW_HEADER,
      "Coding tools  claude, codex",
      `Workspace     ${git.url}`,
      "",
      ...populatedSelections,
    ].join("\n"),
  );

  expect(lastConfirmMessage()).toBe(SAVE_PROMPT);
});

test("an empty git review leaves out the individual assets section", async (t) => {
  const { review } = await reviewScreen(t, "git", false);

  expect(review).toBe(
    [
      REVIEW_HEADER,
      "Coding tools  none",
      `Workspace     ${git.url}`,
      "",
      "Scope sets (0)",
      "  None.",
      "",
    ].join("\n"),
  );
});

test("local review shows only tools and the folder, with no scope sections", async (t) => {
  const { review, output } = await reviewScreen(t, "local", true);

  expect(review).toBe(
    [
      REVIEW_HEADER,
      "Coding tools  claude, codex",
      "Workspace     /fixture/local",
      "",
    ].join("\n"),
  );

  expect(output).toContain("Saved to fixture-config");
  expect(synchronize).toHaveBeenCalledTimes(1);
});

type SetupOptions = Parameters<typeof runSetup>[0];

const gitSetup = (home: string) => ({
  runtime: testRuntime(home),
  restart: true,
  interactive: true,
  repo: git.url,
  confirmRestart: async () => true,
  write: vi.fn(),
});

const clonePrompt = (home: string) =>
  `Clone it now into ${join(home, ".barndog", "git")}? Git will ask for anything it needs.`;

function setupCancelled() {
  vi.mocked(initialize).mockResolvedValue({
    configPath: "fixture",
    harnesses: [],
    cancelled: true,
  });
}

test("a denied repository shows the access error and offers to clone it", async (t) => {
  const server = await cloud(t);
  vi.mocked(inspectRepository).mockRejectedValue(
    new RepositoryAccessError("denied"),
  );

  setupCancelled();
  vi.mocked(confirm).mockResolvedValue(true);
  const options = gitSetup(server.home);
  await runSetup(options);

  const output = options.write.mock.calls.flat().join("\n");
  expect(output).toContain("denied");
  expect(output).toContain(
    "Git has to be able to clone this repo on this machine.",
  );

  expect(lastConfirmMessage()).toBe(clonePrompt(server.home));
  expect(cloneGitWorkspace).toHaveBeenCalledWith(git.url, expect.anything());
  expect(createGitWorkspace).not.toHaveBeenCalled();
  expect(connectGitWorkspace).not.toHaveBeenCalled();
});

test("declining to clone a denied repository fails with the access error and installs nothing", async (t) => {
  const server = await cloud(t);
  const denied = new RepositoryAccessError("denied");
  vi.mocked(inspectRepository).mockRejectedValue(denied);
  vi.mocked(confirm).mockResolvedValue(false);

  await expect(runSetup(gitSetup(server.home))).rejects.toBe(denied);

  expect(lastConfirmMessage()).toBe(clonePrompt(server.home));
  expect(cloneGitWorkspace).not.toHaveBeenCalled();
  expect(createGitWorkspace).not.toHaveBeenCalled();
  expect(connectGitWorkspace).not.toHaveBeenCalled();
  expect(initialize).not.toHaveBeenCalled();
});

test("an unexpected repository error is rethrown without prompting", async (t) => {
  const server = await cloud(t);
  const unexpected = new Error("unexpected");
  vi.mocked(inspectRepository).mockRejectedValue(unexpected);

  await expect(runSetup(gitSetup(server.home))).rejects.toBe(unexpected);

  expect(confirm).not.toHaveBeenCalled();
  expect(cloneGitWorkspace).not.toHaveBeenCalled();
  expect(createGitWorkspace).not.toHaveBeenCalled();
  expect(initialize).not.toHaveBeenCalled();
});

test("an empty repository asks before turning it into a workspace, then creates it", async (t) => {
  const server = await cloud(t);
  vi.mocked(inspectRepository).mockResolvedValue(null);
  setupCancelled();
  vi.mocked(confirm).mockResolvedValue(true);
  const options = gitSetup(server.home);
  await runSetup(options);

  expect(lastConfirmMessage()).toBe(
    `${git.url} is empty. Set it up as a BarnDog workspace?`,
  );

  expect(createGitWorkspace).toHaveBeenCalledWith(
    git.url,
    "repo",
    expect.anything(),
  );

  expect(cloneGitWorkspace).not.toHaveBeenCalled();
  expect(connectGitWorkspace).not.toHaveBeenCalled();
  expect(options.write.mock.calls.flat().join("\n")).toContain(
    "Next, protect the default branch on your Git host",
  );
});

test("declining to set up an empty repository stops without touching it", async (t) => {
  const server = await cloud(t);
  vi.mocked(inspectRepository).mockResolvedValue(null);
  vi.mocked(confirm).mockResolvedValue(false);

  const error = await runSetup(gitSetup(server.home)).catch(
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(CliError);
  expect(error).toHaveProperty(
    "message",
    "Setup stopped. The repository was not changed.",
  );

  expect(createGitWorkspace).not.toHaveBeenCalled();
  expect(cloneGitWorkspace).not.toHaveBeenCalled();
  expect(initialize).not.toHaveBeenCalled();
});

test("a repository that already holds a workspace is connected without prompting", async (t) => {
  const server = await cloud(t);
  vi.mocked(inspectRepository).mockResolvedValue({
    branch: "trunk",
    commit: "a".repeat(40),
  });

  setupCancelled();
  await runSetup(gitSetup(server.home));

  expect(confirm).not.toHaveBeenCalled();
  expect(connectGitWorkspace).toHaveBeenCalledWith(
    git.url,
    "trunk",
    expect.anything(),
  );

  expect(createGitWorkspace).not.toHaveBeenCalled();
});

test("cancelling setup removes a local folder that this run created", async (t) => {
  const server = await cloud(t);
  setupCancelled();
  const options: SetupOptions = {
    runtime: testRuntime(server.home),
    restart: true,
    interactive: true,
    local: true,
    confirmRestart: async () => true,
    write: vi.fn(),
  };

  await runSetup(options);

  expect(existsSync(barndogPaths(server.home).localWorkspace)).toBe(false);
  expect(vi.mocked(options.write!).mock.calls.flat().join("\n")).toContain(
    "Setup cancelled. Configuration and installed assets were not changed.",
  );
});

test("cancelling setup keeps a local folder that existed before", async (t) => {
  const server = await cloud(t);
  const runtime = testRuntime(server.home);
  await localWorkspace(runtime);
  setupCancelled();

  await runSetup({
    runtime,
    restart: true,
    interactive: true,
    local: true,
    confirmRestart: async () => true,
    write: vi.fn(),
  });

  expect(existsSync(barndogPaths(server.home).localWorkspace)).toBe(true);
});

// Only a fresh local folder is cleaned up on cancel (onboarding.ts discardWorkspace);
// a Git workspace created or cloned during a cancelled run stays under ~/.barndog/git.
test("cancelling setup discards a Git workspace clone created during the run", async (t) => {
  const server = await cloud(t);
  const clone = join(barndogPaths(server.home).git, `${ID}.git`);
  vi.mocked(inspectRepository).mockResolvedValue(null);
  vi.mocked(createGitWorkspace).mockImplementation(async () => {
    await mkdir(clone, { recursive: true });

    return git;
  });

  setupCancelled();
  await runSetup(gitSetup(server.home));

  expect(existsSync(clone)).toBe(false);
});

test("cancelling setup keeps a Git workspace clone an earlier setup made", async (t) => {
  const server = await cloud(t);
  const clone = join(barndogPaths(server.home).git, `${ID}.git`);
  await mkdir(clone, { recursive: true });
  vi.mocked(inspectRepository).mockResolvedValue({
    branch: "main",
    commit: "a".repeat(40),
  });

  setupCancelled();
  await runSetup(gitSetup(server.home));

  expect(existsSync(clone)).toBe(true);
});

test("cloud setup retries authentication only for a missing session", async (t) => {
  const server = await cloud(t);
  const options = {
    runtime: testRuntime(server.home),
    restart: true,
    interactive: true,
    server: "http://127.0.0.1:9",
    confirmRestart: async () => true,
    write: vi.fn(),
  };

  vi.mocked(authStatus).mockRejectedValueOnce(new LoginRequiredError());
  vi.mocked(initialize).mockResolvedValue({
    configPath: "fixture",
    harnesses: [],
    cancelled: true,
  });

  await runSetup(options);
  expect(runLogin).toHaveBeenCalledWith(
    expect.objectContaining({ force: true, browser: true }),
    expect.any(Function),
  );

  vi.mocked(authStatus).mockRejectedValueOnce(new Error("offline"));
  await expect(runSetup(options)).rejects.toThrow("offline");
});

for (const choice of ["keep", "copy", "move", "leave"] as const) {
  test(`reconnecting setup handles kept local assets with ${choice}`, async (t) => {
    const server = await cloud(t);
    const runtime = testRuntime(server.home);
    const local = await localWorkspace(runtime);
    await mkdir(join(local.path, "org/skills/local"), { recursive: true });
    await writeFile(
      join(local.path, "org/skills/local/SKILL.md"),
      "---\nname: local\ndescription: Local\n---\nLocal\n",
    );

    const settings = (await readSettings(server.home))!;
    await saveSettings({ ...settings, localWorkspace: local }, server.home);
    vi.mocked(initialize).mockResolvedValue({
      configPath: "fixture",
      harnesses: [],
    });

    vi.mocked(cloudMoveTargets).mockResolvedValue([
      { value: "org", name: "Org" },
    ]);

    vi.mocked(moveLocalAssets).mockResolvedValue({
      target: "org",
      keepLocal: choice === "copy",
      removed: [],
      rows: [{ kind: "skill", name: "local", status: "moved" }],
    });

    const pick = vi.fn().mockResolvedValue(choice);
    const write = vi.fn();
    const output = write.mock.calls;
    await runSetup({
      runtime,
      interactive: true,
      restart: true,
      confirmRestart: async () => true,
      chooseConnection: async () => ({
        kind: "cloud",
        server: "http://127.0.0.1:9",
      }),
      chooseLocalAssets: pick,
      chooseMoveTarget: async () => "org",
      write,
    });

    expect(pick).toHaveBeenCalledWith(1);
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        keepLocal: choice === "leave" ? undefined : local,
      }),
    );

    const shares = choice === "move" || choice === "copy";
    expect(moveLocalAssets).toHaveBeenCalledTimes(shares ? 1 : 0);
    if (shares) {
      expect(moveLocalAssets).toHaveBeenCalledWith(
        { to: "org", keepLocal: choice === "copy" },
        runtime,
      );

      expect(output.flat().join("\n")).toMatch(/moved\s+skill\s+local/);
    } else {
      expect(output.flat().join("\n")).not.toContain("Status");
    }
  });
}

test("conflicting source flags fail before setup asks anything", async (t) => {
  const server = await cloud(t);
  const confirmRestart = vi.fn(async () => true);

  await expect(
    runSetup({
      runtime: testRuntime(server.home),
      restart: true,
      interactive: true,
      local: true,
      server: "https://barndog.example",
      confirmRestart,
      write: vi.fn(),
    }),
  ).rejects.toThrow("--local, --repo and --server can't be combined");

  expect(confirmRestart).not.toHaveBeenCalled();
});
