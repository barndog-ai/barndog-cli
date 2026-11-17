import { beforeEach, expect, test, vi } from "vitest";
import { runtimeRequirements } from "../features/native/adapters.js";
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
  ).toBe("Missing runtime: python3");
});

test("an invalid declared version range is reported as the Hook author's mistake", async () => {
  expect(
    await runtimeRequirements(
      "claude",
      { commands: [], harnessVersion: "bad range" },
      runtime,
    ),
  ).toBe("Invalid declared harness version requirement: bad range");
});

const requirements = { commands: [], harnessVersion: ">=2" };

test("a coding tool that isn't installed can't have its version checked", async () => {
  vi.mocked(findExecutable).mockResolvedValue(null);

  expect(await runtimeRequirements("claude", requirements, runtime)).toBe(
    "Cannot verify claude version: harness command is missing",
  );
});

for (const [situation, output, expected] of [
  ["new enough", "Claude 2.3.0", null],
  ["too old", "Claude 1.0.0", "claude 1.0.0 does not meet >=2"],
  [
    "unreadable",
    "unknown",
    "Cannot verify claude version: /fake/claude --version printed no version",
  ],
] as const) {
  test(`a coding tool whose version is ${situation} is reported as such`, async () => {
    vi.mocked(findExecutable).mockResolvedValue("/fake/claude");
    vi.mocked(programOutput).mockResolvedValue(output);

    expect(await runtimeRequirements("claude", requirements, runtime)).toBe(
      expected,
    );
  });
}

test("a version command that fails can't be checked", async () => {
  vi.mocked(findExecutable).mockResolvedValue("/fake/claude");
  vi.mocked(programOutput).mockRejectedValue(new Error("version failed"));

  expect(await runtimeRequirements("claude", requirements, runtime)).toBe(
    "Cannot verify claude version",
  );
});
