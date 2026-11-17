import { stripVTControlCharacters } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { CommanderError, InvalidArgumentError } from "commander";
import { CliError, NothingToDoError } from "../errors.js";
import { testRuntime } from "./runtime.js";

const entry = vi.hoisted(() => ({
  parse: vi.fn(),
  create: vi.fn(),
  guard: vi.fn(),
}));

vi.mock("../program.js", () => ({
  captureRuntime: () => testRuntime("/unused"),
  createProgram: entry.create,
}));

vi.mock("../commands/availability.js", () => ({
  currentSetupMode: async () => undefined,
  assertCommandAvailable: entry.guard,
}));

vi.doMock("../errors.js", async (original) => ({
  ...(await original<typeof import("../errors.js")>()),
  CliError,
  NothingToDoError,
}));

const argv = process.argv;
const exitCode = process.exitCode;
afterEach(() => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

type Printed = { stdout: unknown[]; stderr: unknown[] };

type Failure = {
  name: string;
  error: Error;
  code: number | undefined;
  text: Printed;
  json: Printed;
};

const CHOOSE_SUBCOMMAND = "Choose a subcommand. Add --help to see them.";
const nothing: Printed = { stdout: [], stderr: [] };
const failures: Failure[] = [
  {
    name: "help requested",
    error: new CommanderError(0, "commander.helpDisplayed", "help"),
    code: 0,
    text: nothing,
    json: nothing,
  },
  {
    name: "bare command without a subcommand",
    error: new CommanderError(1, "commander.help", "error: help"),
    code: 1,
    // Commander already printed the help text.
    text: nothing,
    json: {
      stdout: [],
      stderr: [{ error: { message: CHOOSE_SUBCOMMAND } }],
    },
  },
  {
    name: "unknown option",
    error: new CommanderError(
      1,
      "commander.unknownOption",
      "error: unknown option '--nope'",
    ),
    code: 1,
    text: nothing,
    json: {
      stdout: [],
      stderr: [{ error: { message: "unknown option '--nope'" } }],
    },
  },
  {
    name: "invalid argument",
    error: new InvalidArgumentError("invalid argument"),
    code: 1,
    text: { stdout: [], stderr: ["✖ invalid argument"] },
    json: { stdout: [], stderr: [{ error: { message: "invalid argument" } }] },
  },
  {
    name: "cancelled prompt",
    error: Object.assign(new Error("cancel"), { name: "ExitPromptError" }),
    code: 130,
    text: { stdout: ["Cancelled. Nothing was changed."], stderr: [] },
    json: {
      stdout: [{ message: "Cancelled. Nothing was changed." }],
      stderr: [],
    },
  },
  {
    name: "nothing to do",
    error: new NothingToDoError("No assets available"),
    code: undefined,
    text: { stdout: ["No assets available"], stderr: [] },
    json: { stdout: [{ message: "No assets available" }], stderr: [] },
  },
  {
    name: "fixable failure",
    error: new CliError("problem", "barndog init"),
    code: 1,
    text: { stdout: [], stderr: ["✖ problem\n  Fix: barndog init"] },
    json: {
      stdout: [],
      stderr: [{ error: { message: "problem", fix: "barndog init" } }],
    },
  },
  {
    name: "unexpected failure",
    error: new Error("unexpected failure"),
    code: 1,
    text: { stdout: [], stderr: ["✖ unexpected failure"] },
    json: {
      stdout: [],
      stderr: [{ error: { message: "unexpected failure" } }],
    },
  },
];

/**
 * The lines a console spy received, with terminal styling removed and JSON
 * objects parsed when `asJson`.
 */
function printed(spy: { mock: { calls: unknown[][] } }, asJson: boolean) {
  return spy.mock.calls.map(([line]) => {
    const text = stripVTControlCharacters(String(line));

    return asJson && text.startsWith("{")
      ? (JSON.parse(text) as unknown)
      : text;
  });
}

for (const asJson of [false, true]) {
  for (const failure of failures) {
    test(`entry reports ${failure.name} on the right stream (json=${asJson})`, async () => {
      vi.resetModules();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      process.argv = [
        process.execPath,
        "barndog",
        ...(asJson ? ["--json"] : []),
      ];

      process.exitCode = undefined;
      entry.parse.mockRejectedValue(failure.error);
      entry.create.mockReturnValue({ parseAsync: entry.parse });
      await import("../cli.js");
      const expected = asJson ? failure.json : failure.text;

      expect(process.exitCode).toBe(failure.code);
      expect(printed(log, asJson)).toEqual(expected.stdout);
      expect(printed(error, asJson)).toEqual(expected.stderr);
    });
  }
}

test("entry ignores json after the argument terminator and wires its availability guard", async () => {
  vi.resetModules();
  process.argv = [process.execPath, "barndog", "--", "--json"];
  const options: {
    writeError?: unknown;
    guard?: (...args: unknown[]) => void;
  }[] = [];

  entry.create.mockImplementation((given) => {
    options.push(given);
    given.guard(["sync"], {});

    return { parseAsync: entry.parse };
  });

  entry.parse.mockResolvedValue(undefined);
  await import("../cli.js");
  expect(options).toHaveLength(1);
  expect(options[0]!.writeError).toBeUndefined();
  expect(entry.guard).toHaveBeenCalledWith(
    ["sync"],
    {},
    expect.objectContaining({ home: "/unused" }),
  );
});

test("entry silences Commander's own error output when --json is passed", async () => {
  vi.resetModules();
  process.argv = [process.execPath, "barndog", "--json"];
  const options: { writeError?: unknown }[] = [];
  entry.create.mockImplementation((given) => {
    options.push(given);

    return { parseAsync: entry.parse };
  });

  entry.parse.mockResolvedValue(undefined);
  await import("../cli.js");
  expect(options).toHaveLength(1);
  expect(options[0]!.writeError).toBeInstanceOf(Function);
});
