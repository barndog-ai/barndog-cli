import { beforeEach, expect, test, vi } from "vitest";
import {
  missingRequirements,
  requirementFix,
  requirementMessage,
  runtimeRequirements,
  skipReason,
} from "../features/native/requirements.js";
import {
  runtimeExecutable,
  findExecutable,
  programOutput,
} from "../platform.js";
import { testRuntime } from "./runtime.js";

vi.mock("../platform.js", async (original) => ({
  ...(await original<typeof import("../platform.js")>()),
  runtimeExecutable: vi.fn(),
  findExecutable: vi.fn(),
  programOutput: vi.fn(),
}));

const runtime = testRuntime("/unused");
beforeEach(() => vi.resetAllMocks());

test("a missing runtime command is named, even after ones that are present", async () => {
  vi.mocked(runtimeExecutable).mockImplementation(async (command) =>
    command === "node" ? "/fake/node" : null,
  );

  expect(
    await runtimeRequirements("claude", { commands: ["node"] }, runtime),
  ).toBeNull();

  expect(
    await runtimeRequirements(
      "claude",
      { commands: ["node", "python3"] },
      runtime,
    ),
  ).toEqual({ type: "command", command: "python3" });
});

test("an invalid declared version range is reported as the Hook author's mistake", async () => {
  expect(
    await runtimeRequirements(
      "claude",
      { commands: [], harnessVersion: "bad range" },
      runtime,
    ),
  ).toEqual({ type: "invalid-range", range: "bad range" });
});

const requirements = { commands: [], harnessVersion: ">=2" };

test("a coding tool that isn't installed can't have its version checked", async () => {
  vi.mocked(findExecutable).mockResolvedValue(null);

  expect(await runtimeRequirements("claude", requirements, runtime)).toEqual({
    type: "tool-missing",
    range: ">=2",
  });
});

for (const [situation, output, expected] of [
  ["new enough", "Claude 2.3.0", null],
  [
    "too old",
    "Claude 1.0.0",
    { type: "version", range: ">=2", installed: "1.0.0" },
  ],
  ["unreadable", "unknown", { type: "version-unknown", range: ">=2" }],
] as const) {
  test(`a coding tool whose version is ${situation} is reported as such`, async () => {
    vi.mocked(findExecutable).mockResolvedValue("/fake/claude");
    vi.mocked(programOutput).mockResolvedValue(output);

    expect(await runtimeRequirements("claude", requirements, runtime)).toEqual(
      expected,
    );
  });
}

test("a version command that fails can't be checked", async () => {
  vi.mocked(findExecutable).mockResolvedValue("/fake/claude");
  vi.mocked(programOutput).mockRejectedValue(new Error("version failed"));

  expect(await runtimeRequirements("claude", requirements, runtime)).toEqual({
    type: "version-unknown",
    range: ">=2",
  });
});

test("every missing requirement is reported, in the order declared", async () => {
  vi.mocked(runtimeExecutable).mockResolvedValue(null);
  vi.mocked(findExecutable).mockResolvedValue(null);

  expect(
    await missingRequirements(
      "claude",
      { commands: ["deno", "jq"], harnessVersion: ">=2" },
      runtime,
    ),
  ).toEqual([
    { type: "command", command: "deno" },
    { type: "command", command: "jq" },
    { type: "tool-missing", range: ">=2" },
  ]);
});

const sentences = [
  [
    { type: "command", command: "deno" },
    "needs the deno command, which isn't installed here or isn't on your PATH",
    "Install deno",
  ],
  [
    { type: "invalid-range", range: "bad" },
    "declares a Claude Code version BarnDog can't read: bad",
    "Ask the Hook's author to fix requirements.harnessVersion in hook.yaml",
  ],
  [
    { type: "tool-missing", range: ">=2" },
    "needs Claude Code >=2, but BarnDog can't find Claude Code to check its version",
    "Install or update Claude Code",
  ],
  [
    { type: "version-unknown", range: ">=2" },
    "needs Claude Code >=2, but BarnDog couldn't read Claude Code's version",
    "Install or update Claude Code",
  ],
  [
    { type: "version", range: ">=2", installed: "1.0.0" },
    "needs Claude Code >=2; this machine has 1.0.0",
    "Install or update Claude Code",
  ],
] as const;

test.each(sentences)(
  "a missing requirement %j reads as what is missing and how to fix it",
  (missing, message, fix) => {
    expect(requirementMessage("claude", missing)).toBe(message);
    expect(requirementFix("claude", missing)).toBe(fix);
  },
);

test("each skip reads as a reason for --json", () => {
  expect(skipReason("codex", { type: "no-implementation" })).toBe(
    "No implementation for this harness",
  );

  expect(skipReason("opencode", { type: "no-command-hooks" })).toBe(
    "OpenCode has no command hooks",
  );

  expect(
    skipReason("claude", {
      type: "missing-requirement",
      requirement: { type: "command", command: "deno" },
    }),
  ).toBe(
    "needs the deno command, which isn't installed here or isn't on your PATH",
  );
});
