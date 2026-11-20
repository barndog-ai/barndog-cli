import { beforeEach, expect, test, vi } from "vitest";
import { createProgram } from "../program.js";
import { askSecret, readStdin } from "../ui/secret-input.js";
import { CliError } from "../errors.js";

vi.mock("../ui/secret-input.js", () => ({
  askSecret: vi.fn(),
  readStdin: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(askSecret).mockReset();
  vi.mocked(readStdin).mockReset();
});

type Machine = { platform: NodeJS.Platform; home: string; sep: string };

const linux: Machine = { platform: "linux", home: "/home/dev", sep: "/" };
const windows: Machine = {
  platform: "win32",
  home: "C:\\Users\\dev",
  sep: "\\",
};

/** A file in the machine's home, written with its separator. */
const inHome = (machine: Machine, ...parts: string[]) =>
  [machine.home, ...parts].join(machine.sep);

function program(
  interactive: boolean,
  extra: string[] = [],
  machine: Machine = linux,
) {
  const kept: [string, string][] = [];
  const output: string[] = [];
  const secrets = inHome(machine, ".barndog", "secrets.json");
  const cli = createProgram({
    interactive,
    home: machine.home,
    platform: machine.platform,
    write: (line) => output.push(line),
    keepMcpValue: async (variable, value) => {
      kept.push([variable, value]);

      return { file: secrets, events: [] };
    },
    forgetMcpValue: async () => ({
      file: secrets,
      events: [
        {
          type: "notice",
          message: "Removed the kept value of A from ~/.claude.json.",
        },
      ],
    }),
    listKeptValues: async () => [
      {
        variable: "API_KEY",
        writtenTo: [
          { file: inHome(machine, ".claude.json"), server: "tickets" },
        ],
      },
      { variable: "UNUSED", writtenTo: [] },
    ],
  });

  const run = (...args: string[]) =>
    cli.parseAsync(["mcp", "env", ...args, ...extra], { from: "user" });

  return { run, kept, output };
}

test("set reads the value from standard input or a masked prompt, and says where it's kept", async () => {
  vi.mocked(readStdin).mockResolvedValue("from-stdin");
  vi.mocked(askSecret).mockResolvedValue("typed");
  const piped = program(false);
  await piped.run("set", "API_KEY", "--stdin");
  const typed = program(true);
  await typed.run("set", "TOKEN");

  expect([...piped.kept, ...typed.kept]).toStrictEqual([
    ["API_KEY", "from-stdin"],
    ["TOKEN", "typed"],
  ]);

  expect(askSecret).toHaveBeenCalledWith("TOKEN");
  const text = typed.output.join("\n");
  expect(text).toMatch(
    /Saved TOKEN in ~\/\.barndog\/secrets\.json, readable only by you\. It stays on this machine and is never uploaded\./,
  );

  expect(text).not.toContain("typed");
});

test("set without a terminal or --stdin refuses, so the value never goes on the command line", async () => {
  const f = program(false);
  await expect(f.run("set", "API_KEY")).rejects.toSatisfy(
    (error: CliError) => error.hint === "barndog mcp env set API_KEY --stdin",
  );

  expect(f.kept).toStrictEqual([]);
});

test("list names variables and where they're written, never values; unset reports what it removed", async () => {
  const f = program(false);
  await f.run("list");
  await f.run("unset", "A");
  const text = f.output.join("\n");
  expect(text).toContain(
    "Kept in ~/.barndog/secrets.json on this machine only. Values aren't shown.",
  );

  expect(text).toMatch(/API_KEY\s+~\/\.claude\.json \(tickets\)/);
  expect(text).toMatch(/UNUSED\s+not written anywhere yet/);
  expect(text).toMatch(/Removed A from ~\/\.barndog\/secrets\.json/);
  expect(text).toMatch(/Removed the kept value of A/);

  const json = program(false, ["--json"]);
  await json.run("set", "API_KEY", "--stdin");
  await json.run("list");
  expect(JSON.parse(json.output[0]!)).toStrictEqual({
    variable: "API_KEY",
    file: "/home/dev/.barndog/secrets.json",
  });

  expect(JSON.parse(json.output[1]!)[0].variable).toBe("API_KEY");
});

test("Windows paths print with backslashes, the header's too", async () => {
  vi.mocked(readStdin).mockResolvedValue("value");
  const f = program(false, [], windows);
  await f.run("set", "API_KEY", "--stdin");
  await f.run("list");
  const text = f.output.join("\n");

  expect(text).toContain("Saved API_KEY in ~\\.barndog\\secrets.json,");
  expect(text).toContain("Kept in ~\\.barndog\\secrets.json on this machine");
  expect(text).toMatch(/API_KEY\s+~\\\.claude\.json \(tickets\)/);
});

test("list says when nothing is kept", async () => {
  const output: string[] = [];
  await createProgram({
    write: (line) => output.push(line),
    listKeptValues: async () => [],
  }).parseAsync(["mcp", "env", "list"], { from: "user" });

  expect(output.join("\n")).toMatch(/BarnDog keeps no MCP values/);
});
