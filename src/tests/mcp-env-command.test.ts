import { beforeEach, expect, test, vi } from "vitest";
import { createProgram } from "../program.js";
import { askSecret, askUseUnassigned, readStdin } from "../ui/secret-input.js";
import { CliError } from "../errors.js";
import { pickOne } from "../ui/pick.js";
import type { McpServerRecord } from "../config/state.js";
import type {
  KeptValueChange,
  KeptVariable,
  ServerVariable,
} from "../features/mcps/values.js";
import type { KeptValue } from "../features/secrets/index.js";

vi.mock("../ui/pick.js", async (original) => ({
  ...(await original<typeof import("../ui/pick.js")>()),
  pickOne: vi.fn(),
}));

vi.mock("../ui/secret-input.js", () => ({
  askSecret: vi.fn(),
  askUseUnassigned: vi.fn(),
  readStdin: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(pickOne).mockReset();
  vi.mocked(askSecret).mockReset();
  vi.mocked(askUseUnassigned).mockReset();
  vi.mocked(readStdin).mockReset();
});

type Machine = { platform: NodeJS.Platform; home: string; sep: string };

const linux: Machine = { platform: "linux", home: "/home/dev", sep: "/" };
const windows: Machine = {
  platform: "win32",
  home: "C:\\Users\\dev",
  sep: "\\",
};

// ~/.barndog paths are built by the host's own path rules, so the default
// machine is the host; the Windows test also runs as Windows elsewhere.
const host = process.platform === "win32" ? windows : linux;

/** A file in the machine's home, written with its separator. */
const inHome = (machine: Machine, ...parts: string[]) =>
  [machine.home, ...parts].join(machine.sep);

/** The same file as the CLI shows it, from ~. */
const shown = (machine: Machine, ...parts: string[]) =>
  ["~", ...parts].join(machine.sep);

/** A table row's cells, found by its first two cells. */
const row = (text: string, first: string, second: string) =>
  text
    .split("\n")
    .map((line) => line.trim().split(/\s{2,}/))
    .find((cells) => cells[0] === first && cells[1] === second);

const tickets: McpServerRecord = {
  id: "id-tickets",
  name: "tickets",
  installedName: "tickets",
  versionId: "v1",
  variables: ["API_KEY", "TOKEN"],
  enabled: true,
};

const paused: McpServerRecord = {
  ...tickets,
  id: "id-paused",
  name: "paused",
  installedName: "paused",
  enabled: false,
};

function program(
  interactive: boolean,
  extra: string[] = [],
  machine: Machine = host,
  notWritten?: KeptValueChange["notWritten"],
) {
  const kept: [ServerVariable, KeptValue][] = [];
  const assigned: ServerVariable[] = [];
  const forgotten: (ServerVariable | string)[] = [];
  const output: string[] = [];
  const secrets = inHome(machine, ".barndog", "secrets.json");
  const change: KeptValueChange = {
    file: secrets,
    events: [],
    ...(notWritten ? { notWritten } : {}),
  };

  const listed: KeptVariable[] = [
    {
      server: "tickets",
      assetId: "id-tickets",
      enabled: true,
      variable: "API_KEY",
      writtenTo: [inHome(machine, ".claude.json")],
    },
    {
      server: "github",
      assetId: "id-github",
      enabled: true,
      variable: "GITHUB_PERSONAL_ACCESS_TOKEN",
      from: "GITHUB_TOKEN",
      writtenTo: [],
    },
    {
      server: "github",
      assetId: "id-github",
      enabled: true,
      variable: "OTHER",
      writtenTo: [],
    },
    {
      server: "paused",
      assetId: "id-paused",
      enabled: false,
      variable: "API_KEY",
      writtenTo: [],
    },
    {
      server: null,
      assetId: null,
      enabled: null,
      variable: "UNUSED",
      writtenTo: [],
    },
  ];

  const cli = createProgram({
    interactive,
    home: machine.home,
    platform: machine.platform,
    write: (line) => output.push(line),
    keepMcpValue: async (target, value) => {
      kept.push([target, value]);

      return change;
    },
    assignKeptValue: async (target) => {
      assigned.push(target);

      return change;
    },
    forgetMcpValue: async (target) => {
      forgotten.push(target);

      return {
        file: secrets,
        events: [
          {
            type: "notice",
            message: "Removed the kept value of API_KEY from ~/.claude.json.",
          },
        ],
      };
    },
    forgetUnassignedValue: async (variable) => {
      forgotten.push(variable);

      return change;
    },
    listKeptValues: async () => listed,
    recordedMcpServers: async () => [tickets, paused],
  });

  const run = (...args: string[]) =>
    cli.parseAsync(["mcp", "env", ...args, ...extra], { from: "user" });

  return { run, kept, assigned, forgotten, output };
}

test("set keeps a value for one server, from standard input or a masked prompt, and says where", async () => {
  vi.mocked(readStdin).mockResolvedValue("from-stdin");
  vi.mocked(askSecret).mockResolvedValue("typed");
  const piped = program(false);
  await piped.run("set", "tickets", "API_KEY", "--stdin");
  const typed = program(true);
  await typed.run("set", "tickets", "TOKEN");

  expect([...piped.kept, ...typed.kept]).toStrictEqual([
    [{ server: "tickets", variable: "API_KEY" }, { value: "from-stdin" }],
    [{ server: "tickets", variable: "TOKEN" }, { value: "typed" }],
  ]);

  expect(askSecret).toHaveBeenCalledWith("TOKEN");
  const text = typed.output.join("\n");
  expect(text).toContain(
    `Saved TOKEN for tickets in ${shown(host, ".barndog", "secrets.json")}, readable only by you. It stays on this machine and is never uploaded.`,
  );

  expect(text).not.toContain("typed");
});

test("set --from makes a server read another variable instead", async () => {
  const f = program(false);
  await f.run("set", "github", "GITHUB_PAT", "--from", "GITHUB_TOKEN");
  expect(f.kept).toStrictEqual([
    [{ server: "github", variable: "GITHUB_PAT" }, { from: "GITHUB_TOKEN" }],
  ]);

  expect(f.output.join("\n")).toContain(
    "github reads GITHUB_PAT from $GITHUB_TOKEN.",
  );

  await expect(
    f.run("set", "github", "X", "--from", "Y", "--stdin"),
  ).rejects.toThrow(/either --from or --stdin/);
});

test("set without a terminal needs the server, the variable, and --stdin or --from", async () => {
  const f = program(false);
  await expect(f.run("set")).rejects.toSatisfy(
    (error: CliError) =>
      error.hint === "barndog mcp env set <server> <variable>",
  );

  await expect(f.run("set", "tickets")).rejects.toSatisfy(
    (error: CliError) =>
      error.hint === "barndog mcp env set <server> <variable>",
  );

  await expect(f.run("set", "tickets", "API_KEY")).rejects.toSatisfy(
    (error: CliError) =>
      error.hint === "barndog mcp env set tickets API_KEY --stdin",
  );

  expect(f.kept).toStrictEqual([]);
});

test("set gives a server the value a version 1 file kept with no server", async () => {
  const quiet = program(false);
  await quiet.run("set", "tickets", "UNUSED");
  expect(quiet.assigned).toStrictEqual([
    { server: "tickets", variable: "UNUSED" },
  ]);

  expect(quiet.output.join("\n")).toContain(
    "tickets now uses the value BarnDog kept for UNUSED",
  );

  vi.mocked(askUseUnassigned).mockResolvedValue(true);
  const yes = program(true);
  await yes.run("set", "web", "UNUSED");
  expect(yes.assigned).toStrictEqual([{ server: "web", variable: "UNUSED" }]);

  vi.mocked(askUseUnassigned).mockResolvedValue(false);
  vi.mocked(askSecret).mockResolvedValue("fresh");
  const no = program(true);
  await no.run("set", "web", "UNUSED");
  expect(no.assigned).toStrictEqual([]);
  expect(no.kept).toStrictEqual([
    [{ server: "web", variable: "UNUSED" }, { value: "fresh" }],
  ]);
});

test("list shows each server's values, never the values themselves", async () => {
  const f = program(false);
  await f.run("list");
  const text = f.output.join("\n");
  expect(text).toContain(
    `Kept in ${shown(host, ".barndog", "secrets.json")} on this machine only. Values aren't shown.`,
  );

  expect(row(text, "tickets", "API_KEY")).toStrictEqual([
    "tickets",
    "API_KEY",
    "kept",
    shown(host, ".claude.json"),
  ]);

  expect(row(text, "github", "GITHUB_PERSONAL_ACCESS_TOKEN")).toStrictEqual([
    "github",
    "GITHUB_PERSONAL_ACCESS_TOKEN",
    "reads $GITHUB_TOKEN",
    "not written anywhere yet",
  ]);

  expect(row(text, "paused", "API_KEY")).toStrictEqual([
    "paused",
    "API_KEY",
    "kept",
    "not written (disabled)",
  ]);

  expect(row(text, "not assigned", "UNUSED")).toStrictEqual([
    "not assigned",
    "UNUSED",
    "kept",
    "not written anywhere yet",
  ]);
});

test("unset forgets one server's value, or an unassigned one, and reports it", async () => {
  const f = program(false);
  await f.run("unset", "tickets", "API_KEY");
  // tickets keeps one value, so naming the server is enough.
  await f.run("unset", "tickets");
  await f.run("unset", "--unassigned", "UNUSED");

  expect(f.forgotten).toStrictEqual([
    { server: "tickets", variable: "API_KEY" },
    { server: "tickets", variable: "API_KEY" },
    "UNUSED",
  ]);

  const text = f.output.join("\n");
  expect(text).toContain(
    `Removed API_KEY for tickets from ${shown(host, ".barndog", "secrets.json")}.`,
  );

  expect(text).toMatch(/Removed the kept value of API_KEY/);
  expect(text).toContain("Removed the unassigned value of UNUSED");

  // github keeps two, so without a terminal the variable has to be named.
  await expect(f.run("unset", "github")).rejects.toSatisfy(
    (error: CliError) =>
      error.hint === "barndog mcp env unset <server> <variable>",
  );

  await expect(f.run("unset")).rejects.toBeInstanceOf(CliError);
});

test("--json prints what was kept and the list as data", async () => {
  vi.mocked(readStdin).mockResolvedValue("value");
  const json = program(false, ["--json"]);
  await json.run("set", "tickets", "API_KEY", "--stdin");
  await json.run("set", "github", "PAT", "--from", "GITHUB_TOKEN");
  await json.run("list");

  expect(JSON.parse(json.output[0]!)).toStrictEqual({
    server: "tickets",
    variable: "API_KEY",
    file: inHome(host, ".barndog", "secrets.json"),
  });

  expect(JSON.parse(json.output[1]!)).toMatchObject({
    server: "github",
    variable: "PAT",
    from: "GITHUB_TOKEN",
  });

  expect(JSON.parse(json.output[2]!)[0]).toMatchObject({
    server: "tickets",
    assetId: "id-tickets",
    variable: "API_KEY",
  });
});

test("Windows paths print with backslashes, the header's too", async () => {
  vi.mocked(readStdin).mockResolvedValue("value");
  const f = program(false, [], windows);
  await f.run("set", "tickets", "API_KEY", "--stdin");
  await f.run("list");
  const text = f.output.join("\n");

  expect(text).toContain(
    "Saved API_KEY for tickets in ~\\.barndog\\secrets.json,",
  );

  expect(text).toContain("Kept in ~\\.barndog\\secrets.json on this machine");
  expect(row(text, "tickets", "API_KEY")).toStrictEqual([
    "tickets",
    "API_KEY",
    "kept",
    "~\\.claude.json",
  ]);
});

test("list says when nothing is kept", async () => {
  const output: string[] = [];
  await createProgram({
    write: (line) => output.push(line),
    listKeptValues: async () => [],
  }).parseAsync(["mcp", "env", "list"], { from: "user" });

  expect(output.join("\n")).toMatch(/BarnDog keeps no MCP values/);
});

test("in a terminal, set picks the server and then the variable from lists", async () => {
  vi.mocked(pickOne)
    .mockResolvedValueOnce(tickets)
    .mockResolvedValueOnce("TOKEN");

  vi.mocked(askSecret).mockResolvedValue("typed");
  const f = program(true);
  await f.run("set");

  expect(f.kept).toStrictEqual([
    [{ server: "tickets", variable: "TOKEN" }, { value: "typed" }],
  ]);

  const [servers, variables] = vi.mocked(pickOne).mock.calls;
  expect(servers![1]).toStrictEqual([
    { value: tickets, name: "tickets", hint: undefined },
    { value: paused, name: "paused", hint: "disabled" },
  ]);

  expect(variables![0]).toBe("Choose a variable of tickets");
  expect(variables![1]).toStrictEqual([
    { value: "API_KEY", name: "API_KEY", hint: "kept" },
    { value: "TOKEN", name: "TOKEN", hint: undefined },
  ]);

  // A named server skips the first list.
  vi.mocked(pickOne).mockResolvedValueOnce("API_KEY");
  await f.run("set", "tickets", "--stdin");
  expect(vi.mocked(pickOne).mock.calls[2]![0]).toBe(
    "Choose a variable of tickets",
  );

  await expect(f.run("set", "nobody")).rejects.toThrow(
    /no MCP server called nobody/,
  );
});

test("in a terminal, unset picks a server with kept values, then one of its values", async () => {
  const github = (variable: string) =>
    expect.objectContaining({ server: "github", variable });

  vi.mocked(pickOne)
    .mockImplementationOnce(async (_, choices) => choices[1]!.value)
    .mockImplementationOnce(async (_, choices) => choices[1]!.value)
    .mockImplementationOnce(async (_, choices) => choices[0]!.value);

  const f = program(true);
  await f.run("unset");
  await f.run("unset", "--unassigned");

  const [servers, values, unassigned] = vi.mocked(pickOne).mock.calls;
  expect(servers![1].map((choice) => choice.name)).toStrictEqual([
    "tickets",
    "github",
    "paused",
  ]);

  expect(values![1].map((choice) => choice.value)).toStrictEqual([
    github("GITHUB_PERSONAL_ACCESS_TOKEN"),
    github("OTHER"),
  ]);

  expect(unassigned![1].map((choice) => choice.name)).toStrictEqual(["UNUSED"]);

  expect(f.forgotten).toStrictEqual([
    { server: "github", variable: "OTHER" },
    "UNUSED",
  ]);
});

test("a change the tools didn't get says why, and --json carries the reason", async () => {
  vi.mocked(readStdin).mockResolvedValue("value");
  const disabled = program(false, [], host, { because: "disabled" });
  await disabled.run("set", "paused", "API_KEY", "--stdin");
  expect(disabled.output.join("\n")).toContain(
    "paused is disabled, so your coding tools get the change when you enable it.",
  );

  // Nothing was synced, so no sync summary is shown.
  expect(disabled.output.join("\n")).not.toContain("Sync complete");

  const failed = program(false, [], host, {
    because: "sync-failed",
    message: "Can't reach the BarnDog server at https://barndog.dev.",
    fix: "barndog doctor",
  });

  await failed.run("set", "tickets", "API_KEY", "--stdin");
  const text = failed.output.join("\n");
  expect(text).toContain("Saved API_KEY for tickets");
  expect(text).toContain(
    "Your coding tools weren't updated: Can't reach the BarnDog server at https://barndog.dev.",
  );

  expect(text).toContain("the next barndog sync writes it into them.");
  expect(text).toContain("Fix: barndog doctor");
  expect(text).not.toContain("Sync complete");

  const json = program(false, ["--json"], host, { because: "disabled" });
  await json.run("set", "paused", "API_KEY", "--stdin");
  expect(JSON.parse(json.output[0]!)).toStrictEqual({
    server: "paused",
    variable: "API_KEY",
    file: inHome(host, ".barndog", "secrets.json"),
    notWritten: { because: "disabled" },
  });
});
