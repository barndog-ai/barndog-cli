import { stripVTControlCharacters } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { localRepoSource } from "../features/workspace/repo-source.js";
import { saveSettings, readSettings } from "../config/settings.js";
import { addMcp } from "../ui/add-mcp.js";
import type { AddContext } from "../ui/add-asset.js";
import { testRuntime } from "./runtime.js";
import { CliError } from "../errors.js";

async function fixture(t: {
  onTestFinished: (fn: () => Promise<void>) => void;
}) {
  const home = await mkdtemp(join(tmpdir(), "barndog-add-mcp-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  await saveSettings({ harnesses: ["claude"] }, home);
  const context: AddContext = {
    runtime: testRuntime(home, { cwd: home }),
    interactive: true,
    write: vi.fn(),
    prompts: {
      chooseMany: vi.fn().mockResolvedValue(["0"]),
      chooseOne: vi.fn().mockResolvedValue("paste"),
      paste: vi
        .fn()
        .mockResolvedValue('{"web":{"url":"https://example.com/mcp"}}'),
      yes: vi.fn().mockResolvedValue(true),
      text: vi.fn(),
    },
  };

  return { home, context };
}

test("interactive paste asks for OAuth and saves a server", async (t) => {
  const { context } = await fixture(t);
  await addMcp(undefined, {}, context);
  expect(context.prompts.yes).toHaveBeenCalledWith(
    expect.stringContaining("OAuth"),
    false,
  );

  expect(context.write).toHaveBeenCalledWith(
    expect.stringContaining("Added web"),
  );

  const settings = (await readSettings(context.runtime.home))!;
  const model = await localRepoSource(
    settings.localWorkspace!,
    context.runtime,
  ).model();

  expect(
    model.assets.find((asset) => asset.kind === "mcp" && asset.name === "web")!
      .definition,
  ).toEqual({
    transport: "http",
    url: "https://example.com/mcp",
    headers: {},
    authentication: "native-oauth",
    description: "web MCP server",
  });
});

async function stored(context: AddContext) {
  const settings = await readSettings(context.runtime.home);
  if (!settings?.localWorkspace) {
    return {};
  }

  const model = await localRepoSource(
    settings.localWorkspace,
    context.runtime,
  ).model();

  return Object.fromEntries(
    model.assets.flatMap((asset) =>
      asset.kind === "mcp" ? [[asset.name, asset.definition]] : [],
    ),
  );
}

async function claudeServers(home: string, names: string[]) {
  await mkdir(join(home, ".claude"));
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: Object.fromEntries(
        names.map((name) => [name, { command: "node", args: [name] }]),
      ),
    }),
  );
}

test("importing from coding tools that have no servers says so", async (t) => {
  const { context } = await fixture(t);

  await expect(
    addMcp(undefined, { from: "claude" }, context),
  ).rejects.toMatchObject({
    message:
      "No MCP servers found in your coding tools that BarnDog doesn't already manage.",
  });
});

test("importing a server name your coding tools don't have lists the ones they do", async (t) => {
  const { home, context } = await fixture(t);
  await claudeServers(home, ["one", "two"]);

  const error: unknown = await addMcp("missing", { from: "claude" }, context)
    .then(() => undefined)
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(CliError);
  expect(error).toHaveProperty(
    "message",
    expect.stringMatching(
      /^No MCP server named missing in your coding tools\. They have one \(.+\), two \(.+\)\.$/,
    ),
  );

  expect(await stored(context)).toEqual({});
});

test("without a terminal, several matching servers need a name", async (t) => {
  const { home, context } = await fixture(t);
  await claudeServers(home, ["one", "two"]);
  context.interactive = false;

  await expect(
    addMcp(undefined, { from: "claude" }, context),
  ).rejects.toMatchObject({
    message: expect.stringMatching(
      /^Several servers match: one \(.+\), two \(.+\)\.$/,
    ),
    hint: "barndog mcp add <name> --from <harness>",
  });
});

test("without a terminal, a single server still needs its name, and the error says which it is", async (t) => {
  const { home, context } = await fixture(t);
  await claudeServers(home, ["one"]);
  context.interactive = false;

  await expect(
    addMcp(undefined, { from: "claude" }, context),
  ).rejects.toMatchObject({
    message: expect.stringMatching(
      /^Name the MCP server to add: one \(.+\)\.$/,
    ),
    hint: "barndog mcp add <name> --from <harness>",
  });

  expect(await stored(context)).toEqual({});
});

test("ticking no servers adds nothing", async (t) => {
  const { home, context } = await fixture(t);
  await claudeServers(home, ["one", "two"]);
  vi.mocked(context.prompts.chooseMany).mockResolvedValueOnce([]);

  await expect(addMcp(undefined, { from: "claude" }, context)).rejects.toThrow(
    "No MCP servers were chosen, so nothing was added.",
  );

  expect(await stored(context)).toEqual({});
});

test("the ticked server from a coding tool is added to the local workspace", async (t) => {
  const { home, context } = await fixture(t);
  await claudeServers(home, ["one", "two"]);
  vi.mocked(context.prompts.chooseOne).mockResolvedValueOnce("harness");

  await addMcp(undefined, {}, context);

  expect(Object.keys(await stored(context))).toEqual(["one"]);
  expect(context.write).toHaveBeenCalledWith(
    expect.stringContaining("Added one"),
  );
});

test("replacement requires consent and reports its backup", async (t) => {
  const { home, context } = await fixture(t);
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { one: { command: "node" } } }),
  );

  const original = await readFile(join(home, ".claude.json"), "utf8");
  vi.mocked(context.prompts.yes).mockResolvedValueOnce(false);
  await expect(addMcp("one", { from: "claude" }, context)).rejects.toThrow(
    "Nothing was added",
  );

  expect(await readFile(join(home, ".claude.json"), "utf8")).toBe(original);
  expect((await readSettings(home))!.localWorkspace).toBeUndefined();

  await addMcp("one", { from: "claude" }, context);
  expect(context.write).toHaveBeenCalledWith(
    expect.stringContaining("Backup:"),
  );

  const backup = vi
    .mocked(context.write)
    .mock.calls.map(([line]) => line)
    .find((line) => line.startsWith("Backup: "))!
    .slice("Backup: ".length);

  expect(await readFile(backup, "utf8")).toBe(original);
});

test("two servers replaced in one settings file share one backup of the file as it was", async (t) => {
  const { home, context } = await fixture(t);
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: { one: { command: "node" }, two: { command: "node" } },
    }),
  );

  const original = await readFile(join(home, ".claude.json"), "utf8");
  vi.mocked(context.prompts.chooseMany).mockResolvedValueOnce(["0", "1"]);

  await addMcp(undefined, { from: "claude" }, context);

  const backups = vi
    .mocked(context.write)
    .mock.calls.map(([line]) => line)
    .filter((line) => line.startsWith("Backup: "))
    .map((line) => line.slice("Backup: ".length));

  expect(context.write).toHaveBeenCalledWith(
    expect.stringMatching(/Added two/),
  );

  expect(backups).toHaveLength(1);
  expect(await readFile(backups[0]!, "utf8")).toBe(original);
});

test("invalid Codex TOML names the file instead of a bare parser error", async (t) => {
  const { home, context } = await fixture(t);
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex", "config.toml"), "[mcp_servers\n");

  await expect(
    addMcp(undefined, { from: "claude" }, context),
  ).rejects.toMatchObject({
    name: "CliError",
    message: expect.stringMatching(/config\.toml isn't valid TOML/),
  });
});

test("a server name pasted as the argument is caught as configuration", async (t) => {
  const { context } = await fixture(t);

  await expect(
    addMcp(' {"command":"node"}', {}, context),
  ).rejects.toMatchObject({
    message: "That looks like the configuration, not a name.",
    hint: "barndog mcp add <name> --config '<json>'",
  });
});

test("--file and --config add their servers without asking where the configuration is", async (t) => {
  const { home, context } = await fixture(t);
  const path = join(home, "mcp.json");
  await writeFile(path, '{"file-server":{"command":"node"}}');

  await addMcp(undefined, { file: path }, context);
  await addMcp(
    undefined,
    {
      config:
        '{"http-server":{"url":"https://example.com/mcp","headers":{"X-Key":"value"}}}',
    },
    context,
  );

  const servers = await stored(context);
  expect(Object.keys(servers).sort()).toEqual(["file-server", "http-server"]);
  expect(servers["http-server"]).toMatchObject({
    transport: "http",
    headers: { "X-Key": { secretRef: expect.any(String) } },
  });

  expect(JSON.stringify(servers)).not.toContain('"value"');
  expect(context.prompts.chooseOne).not.toHaveBeenCalled();
  // Without a terminal nothing is kept, so the variable is listed to set.
  const written = vi.mocked(context.write).mock.calls.flat().join("\n");
  expect(stripVTControlCharacters(written)).toMatch(
    /! BarnDog doesn't keep these values\.[^\n]*\n {2}http-server {2}\S+/,
  );
});

test("--file with a server name the file doesn't have adds nothing and lists its names", async (t) => {
  const { home, context } = await fixture(t);
  const path = join(home, "mcp.json");
  await writeFile(
    path,
    '{"mcpServers":{"github":{"command":"gh"},"linear":{"url":"https://example.com/mcp"}}}',
  );

  await expect(addMcp("linaer", { file: path }, context)).rejects.toMatchObject(
    {
      message:
        "No MCP server named linaer in that JSON. It has github, linear.",
    },
  );

  expect(await stored(context)).toEqual({});
});

test("an MCP server keeps a standard name with capitals or underscores", async (t) => {
  const { context } = await fixture(t);
  await addMcp(
    undefined,
    { config: '{"My_Server":{"command":"node"}}' },
    context,
  );

  expect(Object.keys(await stored(context))).toEqual(["My_Server"]);
});

test("a name taken locally, even only in case, asks for another in a terminal", async (t) => {
  const { context } = await fixture(t);
  await addMcp(undefined, { config: '{"docs":{"command":"node"}}' }, context);
  vi.mocked(context.prompts.text)
    .mockResolvedValueOnce("bad name")
    .mockResolvedValueOnce(" Docs_2 ");

  await addMcp(undefined, { config: '{"Docs":{"command":"node"}}' }, context);

  const written = vi.mocked(context.write).mock.calls.map(([line]) => line);
  expect(written).toContainEqual(
    expect.stringMatching(
      /Docs differs from your local MCP server docs only in case/,
    ),
  );

  expect(written).toContainEqual(
    expect.stringMatching(/bad name can't be an MCP server name/),
  );

  expect(Object.keys(await stored(context)).sort()).toEqual(["Docs_2", "docs"]);
});

test("without a terminal, a taken name fails with --as as the fix, and --as renames one server", async (t) => {
  const { context } = await fixture(t);
  const quiet = { ...context, interactive: false };
  await addMcp(undefined, { config: '{"docs":{"command":"node"}}' }, quiet);

  await expect(
    addMcp(undefined, { config: '{"DOCS":{"command":"node"}}' }, quiet),
  ).rejects.toSatisfy(
    (error: CliError) =>
      /only in case/.test(error.message) &&
      error.hint === "barndog mcp add DOCS --as <new-name>",
  );

  await addMcp(
    undefined,
    { config: '{"DOCS":{"command":"node"}}', as: "docs_upper" },
    quiet,
  );

  await expect(
    addMcp(
      undefined,
      { config: '{"a":{"command":"x"},"b":{"command":"y"}}', as: "c" },
      quiet,
    ),
  ).rejects.toThrow(/--as renames one MCP server/);

  expect(Object.keys(await stored(context)).sort()).toEqual([
    "docs",
    "docs_upper",
  ]);
});
