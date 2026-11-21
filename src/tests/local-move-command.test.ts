import { beforeEach, expect, test, vi } from "vitest";
import select from "@inquirer/select";
import { CommanderError } from "commander";
import { createProgram } from "../program.js";
import { pickMany } from "../ui/pick.js";
import type {
  LocalAssets,
  MoveOptions,
  MoveResult,
} from "../features/migration/move.js";
import { CliError } from "../errors.js";

vi.mock("@inquirer/select", () => ({ default: vi.fn() }));
vi.mock("../ui/pick.js", async (original) => ({
  ...(await original<typeof import("../ui/pick.js")>()),
  pickMany: vi.fn(),
}));

const local: LocalAssets = {
  folder: "/home/dev/.barndog/workspace",
  assets: [
    {
      kind: "skill",
      name: "review",
      path: "org/skills/review",
      state: "available",
    },
    {
      kind: "skill",
      name: "busy",
      path: "org/skills/busy",
      state: "moving",
      movingTo: "https://example.test/pull/1",
    },
    {
      kind: "hook",
      name: "broken",
      path: "org/hooks/broken",
      state: "invalid",
    },
  ],
};

const moved: MoveResult = {
  target: "org",
  keepLocal: false,
  removed: [],
  rows: [{ kind: "skill", name: "review", status: "moved" }],
  direct: true,
};

beforeEach(() => {
  vi.mocked(select).mockReset();
  vi.mocked(pickMany).mockReset();
});

function program(interactive: boolean) {
  const calls: MoveOptions[] = [];
  const output: string[] = [];
  const cli = createProgram({
    interactive,
    write: (line) => output.push(line),
    listLocalAssets: async () => local,
    moveLocalAssets: async (options) => {
      calls.push(options);

      return { ...moved, keepLocal: options.keepLocal };
    },
  });

  const run = (...args: string[]) =>
    cli.parseAsync(["local", "move", ...args], { from: "user" });

  return { run, calls, output };
}

test("without names, a terminal picks from the local assets that can move, then asks move or keep", async () => {
  vi.mocked(pickMany).mockResolvedValue(["review"]);
  vi.mocked(select).mockResolvedValue(false);
  const f = program(true);
  await f.run();

  const [, choices] = vi.mocked(pickMany).mock.calls[0]!;
  expect(choices.map((choice) => choice.value)).toStrictEqual(["review"]);
  expect(vi.mocked(select).mock.calls[0]![0].message).toBe(
    "Move it, or share a copy and keep it here too?",
  );

  expect(f.calls).toStrictEqual([
    expect.objectContaining({ names: ["review"], keepLocal: false }),
  ]);

  expect(f.output.join("\n")).toMatch(/local ones removed/);
});

test("--all and the keep flags answer every question", async () => {
  const f = program(false);
  await f.run("review", "--server", "https://other.example");
  await f.run("--all", "--keep-local");
  await f.run("review", "--no-keep-local");

  expect(f.calls).toStrictEqual([
    // Another server leaves this machine as it is, so nothing is asked.
    expect.objectContaining({ names: ["review"], keepLocal: true }),
    expect.objectContaining({ names: undefined, keepLocal: true }),
    expect.objectContaining({ names: ["review"], keepLocal: false }),
  ]);

  expect(f.output.join("\n")).toMatch(/stay as separate assets/);
  expect(pickMany).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
});

for (const [args, message] of [
  [[], /Name the local assets to move, or pass --all/],
  [["review"], /Say whether to keep separate local copies/],
  [["review", "--all", "--keep-local"], /not both/],
] as const) {
  test(`without a terminal, local move ${args.join(" ")} fails with a fix`, async () => {
    const f = program(false);
    await expect(f.run(...args)).rejects.toSatisfy(
      (error) => error instanceof CliError && message.test(error.message),
    );

    expect(f.calls).toStrictEqual([]);
  });
}

test("local move --help explains choosing, moving and keeping", async () => {
  const f = program(false);
  await expect(f.run("--help")).rejects.toBeInstanceOf(CommanderError);
  const help = f.output.join("\n");
  for (const text of [
    "--all",
    "--keep-local",
    "--no-keep-local",
    "a terminal lists your local assets",
    "waits for its pull request",
  ]) {
    expect(help, text).toContain(text);
  }
});

test("--all in a terminal asks once about every asset, and --json prints the move", async () => {
  vi.mocked(select).mockResolvedValue(true);
  const f = program(true);
  await f.run("--all");
  await f.run("review", "--keep-local", "--json");

  expect(vi.mocked(select).mock.calls[0]![0].message).toBe(
    "Move them, or share a copy and keep them here too?",
  );

  expect(f.calls).toStrictEqual([
    expect.objectContaining({ names: undefined, keepLocal: true }),
    expect.objectContaining({ names: ["review"], keepLocal: true }),
  ]);

  expect(JSON.parse(f.output.at(-1)!)).toMatchObject({ keepLocal: true });
});
