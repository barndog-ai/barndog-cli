import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { expect, test, vi, type TestContext } from "vitest";
import { saveSettings } from "../config/settings.js";
import { barndogPaths } from "../config/paths.js";
import { CliError } from "../errors.js";
import { synchronize } from "../features/environment/sync.js";
import {
  assignKeptValue,
  forgetMcpValue,
  forgetUnassignedValue,
  keepMcpValue,
  listKeptValues,
} from "../features/mcps/values.js";
import {
  recordedVariables,
  redacted,
  sameValue,
} from "../features/native/secret-values.js";
import {
  applyKeptValues,
  assertVariableName,
  changeSecrets,
  missingValues,
  readStoredSecrets,
} from "../features/secrets/index.js";
import { doctor } from "../features/doctor/index.js";
import { showMcp } from "../features/mcps/index.js";
import { addMcp } from "../ui/add-mcp.js";
import type { AddContext } from "../ui/add-asset.js";
import { testRuntime } from "./runtime.js";
import { inventory, type InventoryItem } from "../features/inventory/index.js";
import { createProgram } from "../program.js";
import { stripVTControlCharacters } from "node:util";
import { POSIX_MODE } from "../shared/constants.js";

const secret = "sk-very-private";

const entryVariables = new Set([
  "API_KEY",
  "HOME",
  "REGION",
  "TOKEN",
  "WEB_X_KEY",
]);

/** A machine managing every tool, with an MCP server whose entry held literal values. */
async function machine(t: TestContext, keep: string[]) {
  const home = await mkdtemp(join(tmpdir(), "barndog-secrets-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  await saveSettings(
    { harnesses: ["claude", "codex", "cursor", "opencode"] },
    home,
  );

  // None of the entry's variables may come from this process. Windows keeps
  // the rest, since the PowerShell that sets ACLs needs its system variables.
  const runtime = testRuntime(home, {
    env:
      process.platform === "win32"
        ? Object.fromEntries(
            Object.entries(process.env).filter(
              ([name]) => !entryVariables.has(name.toUpperCase()),
            ),
          )
        : {},
  });

  const lines: string[] = [];
  const context: AddContext = {
    runtime,
    interactive: true,
    write: (line) => lines.push(line),
    prompts: {
      // Ticks the values whose variable is in `keep`, whichever server has it.
      chooseMany: vi.fn(
        async (
          _message: string,
          choices: { short?: string; value: string }[],
        ) =>
          choices
            .filter((choice) => keep.includes(choice.short ?? ""))
            .map((choice) => choice.value),
      ),
      chooseOne: vi.fn(),
      paste: vi.fn(),
      yes: vi.fn().mockResolvedValue(false),
      text: vi.fn(),
    },
  };

  await addMcp(
    undefined,
    {
      config: JSON.stringify({
        tickets: {
          command: "tickets",
          env: { API_KEY: secret, REGION: "eu", HOME_DIR: "${HOME}" },
        },
        web: { url: "https://web.example/mcp", headers: { "X-Key": secret } },
      }),
    },
    context,
  );

  const file = (path: string) => readFile(join(home, path), "utf8");
  const ids = async () =>
    Object.fromEntries(
      (await inventory(runtime)).items.map((item) => [item.name, item.id]),
    );

  return { home, runtime, lines, context, file, ids };
}

test("kept values are written into every tool, and state.json records only their hashes", async (t) => {
  const m = await machine(t, ["API_KEY", "WEB_X_KEY"]);

  expect(m.context.prompts.chooseMany).toHaveBeenCalledWith(
    "Which values should BarnDog keep on this machine?",
    [
      expect.objectContaining({ short: "API_KEY", checked: true }),
      expect.objectContaining({ short: "REGION", checked: true }),
      expect.objectContaining({ short: "WEB_X_KEY", checked: true }),
    ],
  );

  const output = m.lines.join("\n");
  expect(output).toMatch(/never uploaded/);
  // Every tool got the same value, so one sentence, then each file under it.
  expect(output.match(/Wrote the kept value of API_KEY/g)).toHaveLength(1);
  expect(stripVTControlCharacters(output)).toMatch(
    /Wrote the kept value of API_KEY for tickets\. It stays on this machine\.\n {4}~\/\.claude\.json\n {4}~\/\.codex\/config\.toml\n/,
  );

  // One sentence per outcome, then a column of variables under each server.
  const plain = stripVTControlCharacters(output);
  expect(plain).toMatch(
    /BarnDog keeps these values in ~\/\.barndog\/secrets\.json[^\n]*\n {2}tickets {2}API_KEY\n {2}web {6}WEB_X_KEY\n/,
  );

  // REGION was left unticked, so the tools refer to the variable.
  expect(plain).toMatch(
    /! BarnDog doesn't keep these values\. Set each in your environment[^\n]*\n {2}tickets {2}REGION/,
  );

  expect(plain.match(/keeps these values/g)).toHaveLength(1);

  const claude = JSON.parse(await m.file(".claude.json"));
  expect(claude.mcpServers.tickets.env).toStrictEqual({
    API_KEY: secret,
    REGION: "${REGION}",
    HOME_DIR: "${HOME}",
  });

  expect(claude.mcpServers.web.headers).toStrictEqual({ "X-Key": secret });
  expect(
    JSON.parse(await m.file(".cursor/mcp.json")).mcpServers.tickets.env.API_KEY,
  ).toBe(secret);

  const opencode = JSON.parse(await m.file(".config/opencode/opencode.jsonc"));
  expect(opencode.mcp.servers.tickets.environment).toMatchObject({
    API_KEY: secret,
    REGION: "{env:REGION}",
  });

  const codex = parseToml(await m.file(".codex/config.toml")) as {
    mcp_servers: Record<string, Record<string, unknown>>;
  };

  expect(codex.mcp_servers.tickets).toMatchObject({
    env: { API_KEY: secret },
    env_vars: ["REGION", "HOME"],
  });

  // HOME_DIR is renamed, so Codex starts the server through the system shell,
  // which renames only that one; the kept API_KEY stays in `env`.
  if (process.platform !== "win32") {
    const [, script, ...server] = codex.mcp_servers.tickets!.args as string[];
    expect(codex.mcp_servers.tickets!.command).toBe("/bin/sh");
    expect(script).toContain(`'HOME_DIR='"$HOME"`);
    expect(script).not.toMatch(/REGION|API_KEY/);
    expect(server).toStrictEqual(["tickets"]);
  }

  expect(codex.mcp_servers.web).toMatchObject({
    http_headers: { "X-Key": secret },
  });

  expect(codex.mcp_servers.web).not.toHaveProperty("env_http_headers");

  // The secret is in the tools and the private store, never in state.json.
  const state = await readFile(barndogPaths(m.home).state, "utf8");
  expect(state).not.toContain(secret);
  expect(state).toMatch(/barndog-secret:API_KEY:sha256:/);
  const ids = await m.ids();
  expect(await readStoredSecrets(m.runtime)).toStrictEqual({
    version: 2,
    servers: {
      [ids.tickets!]: { API_KEY: { value: secret } },
      [ids.web!]: { WEB_X_KEY: { value: secret } },
    },
    unassigned: {},
  });

  // Windows has no mode bits; the ACL set on every write keeps it private.
  if (process.platform !== "win32") {
    expect(
      (await stat(barndogPaths(m.home).secrets)).mode &
        POSIX_MODE.groupAndOtherBits,
    ).toBe(0);
  }

  // Nothing changed, so a second sync leaves every entry as it is.
  const again = await synchronize(undefined, m.runtime);
  expect(
    again.filter((e) => e.type === "native" && e.action !== "unchanged"),
  ).toStrictEqual([]);
});

test("mcp env changes a kept value, lists where it's written, and forgets it", async (t) => {
  const m = await machine(t, ["API_KEY"]);
  const tickets = { server: "tickets", variable: "API_KEY" };

  const changed = await keepMcpValue(tickets, { value: "sk-new" }, m.runtime);
  expect(changed.file).toBe(barndogPaths(m.home).secrets);
  expect(
    JSON.parse(await m.file(".claude.json")).mcpServers.tickets.env.API_KEY,
  ).toBe("sk-new");

  const listed = await listKeptValues(m.runtime);
  expect(listed).toStrictEqual([
    {
      server: "tickets",
      assetId: (await m.ids()).tickets,
      variable: "API_KEY",
      writtenTo: expect.arrayContaining([
        join(m.home, ".claude.json"),
        join(m.home, ".codex/config.toml"),
      ]),
    },
  ]);

  expect(JSON.stringify(listed)).not.toContain("sk-new");

  const forgotten = await forgetMcpValue(tickets, m.runtime);
  // Every tool lost the same value, so one event names all their files.
  expect(
    forgotten.events.filter((e) => e.type === "kept-values"),
  ).toStrictEqual([
    {
      type: "kept-values",
      action: "removed",
      server: "tickets",
      variables: ["API_KEY"],
      files: expect.arrayContaining([
        join(m.home, ".claude.json"),
        join(m.home, ".codex/config.toml"),
      ]),
    },
  ]);

  expect(
    JSON.parse(await m.file(".claude.json")).mcpServers.tickets.env.API_KEY,
  ).toBe("${API_KEY}");

  await expect(forgetMcpValue(tickets, m.runtime)).rejects.toThrow(
    /doesn't keep API_KEY for tickets/,
  );

  await expect(keepMcpValue(tickets, { value: "" }, m.runtime)).rejects.toThrow(
    /empty/,
  );

  await expect(
    keepMcpValue(
      { server: "tickets", variable: "NOPE" },
      { value: "x" },
      m.runtime,
    ),
  ).rejects.toThrow(
    /tickets doesn't use NOPE\. It uses API_KEY, REGION, HOME\./,
  );

  await expect(
    keepMcpValue(
      { server: "nobody", variable: "X" },
      { value: "x" },
      m.runtime,
    ),
  ).rejects.toThrow(/no MCP server called nobody/);
});

test("each server keeps its own value for a variable, or reads another variable", async (t) => {
  const m = await machine(t, ["API_KEY"]);
  await addMcp(
    undefined,
    {
      config: JSON.stringify({
        other: { command: "other", env: { API_KEY: "sk-other" } },
      }),
    },
    m.context,
  );

  const claude = async () =>
    JSON.parse(await m.file(".claude.json")).mcpServers;

  expect((await claude()).tickets.env.API_KEY).toBe(secret);
  expect((await claude()).other.env.API_KEY).toBe("sk-other");

  // REGION now comes from AWS_REGION, for tickets only.
  await keepMcpValue(
    { server: "tickets", variable: "REGION" },
    { from: "AWS_REGION" },
    m.runtime,
  );

  expect((await claude()).tickets.env.REGION).toBe("${AWS_REGION}");
  const codex = parseToml(await m.file(".codex/config.toml")) as {
    mcp_servers: Record<string, { env_vars: string[] }>;
  };

  expect(codex.mcp_servers.tickets!.env_vars).toContain("AWS_REGION");

  expect(
    (await listKeptValues(m.runtime)).find((row) => row.variable === "REGION"),
  ).toMatchObject({ server: "tickets", from: "AWS_REGION" });

  const checks = await doctor(m.runtime);
  expect(
    checks.find((check) => check.fix === "barndog mcp env set tickets REGION")
      ?.detail,
  ).toMatch(
    /AWS_REGION has no value here, so tickets can't read REGION from it/,
  );

  const shown = await showMcp("tickets", "local", m.runtime);
  expect(shown.keptVariables).toContainEqual({
    variable: "REGION",
    from: "AWS_REGION",
  });

  await expect(
    keepMcpValue(
      { server: "tickets", variable: "REGION" },
      { from: "REGION" },
      m.runtime,
    ),
  ).rejects.toThrow(/already reads REGION/);
});

test("a version 1 file gives each value to the servers it was written for", async (t) => {
  const m = await machine(t, ["API_KEY", "WEB_X_KEY"]);
  const path = barndogPaths(m.home).secrets;
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      values: { API_KEY: secret, WEB_X_KEY: secret, STRAY: "x" },
    }),
    { mode: 0o600 },
  );

  await chmod(path, 0o600);
  const events = await synchronize(undefined, m.runtime);
  expect(events).toContainEqual({
    type: "unassigned-value",
    variable: "STRAY",
  });

  expect(
    events.filter((e) => e.type === "native" && e.action !== "unchanged"),
  ).toStrictEqual([]);

  const ids = await m.ids();
  expect(await readStoredSecrets(m.runtime)).toStrictEqual({
    version: 2,
    servers: {
      [ids.tickets!]: { API_KEY: { value: secret } },
      [ids.web!]: { WEB_X_KEY: { value: secret } },
    },
    unassigned: { STRAY: "x" },
  });

  const checks = await doctor(m.runtime);
  expect(checks.map((check) => check.fix)).toContain(
    "barndog mcp env set <server> STRAY",
  );

  // Servers first, by name, then the values no server has.
  expect(
    (await listKeptValues(m.runtime)).map((row) => [row.server, row.variable]),
  ).toStrictEqual([
    ["tickets", "API_KEY"],
    ["web", "WEB_X_KEY"],
    [null, "STRAY"],
  ]);

  await expect(
    assignKeptValue({ server: "tickets", variable: "STRAY" }, m.runtime),
  ).rejects.toThrow(/doesn't use STRAY/);

  await forgetUnassignedValue("STRAY", m.runtime);
  expect((await readStoredSecrets(m.runtime)).version).toBe(2);
  await expect(forgetUnassignedValue("STRAY", m.runtime)).rejects.toThrow(
    /no unassigned value for STRAY/,
  );
});

test("an unassigned value can be given to a server", async (t) => {
  const m = await machine(t, []);
  const path = barndogPaths(m.home).secrets;
  await writeFile(
    path,
    JSON.stringify({ version: 1, values: { REGION: "eu-west-1" } }),
    { mode: 0o600 },
  );

  await chmod(path, 0o600);
  await assignKeptValue({ server: "tickets", variable: "REGION" }, m.runtime);
  expect(
    JSON.parse(await m.file(".claude.json")).mcpServers.tickets.env.REGION,
  ).toBe("eu-west-1");

  expect((await readStoredSecrets(m.runtime)).version).toBe(2);
  expect(await listKeptValues(m.runtime)).toStrictEqual([
    expect.objectContaining({ server: "tickets", variable: "REGION" }),
  ]);

  await expect(
    assignKeptValue({ server: "tickets", variable: "REGION" }, m.runtime),
  ).rejects.toThrow(/no unassigned value for REGION/);
});

test("without a terminal nothing is kept, and doctor names each variable with no value", async (t) => {
  const m = await machine(t, []);
  const quiet = { ...m.context, interactive: false };
  await addMcp(
    undefined,
    {
      config: JSON.stringify({ other: { command: "o", env: { TOKEN: "x" } } }),
    },
    quiet,
  );

  expect(await readStoredSecrets(m.runtime)).toStrictEqual({
    version: 2,
    servers: {},
    unassigned: {},
  });

  const checks = await doctor(m.runtime);
  const variables = checks.filter((check) => check.name.startsWith("MCP"));
  expect(variables).toHaveLength(1);
  expect(variables[0]).toMatchObject({
    name: "MCP variables",
    detail: expect.stringMatching(/^5 variables have no value here/),
    fix: "barndog mcp env set <server> <variable>",
  });

  const rows = Object.fromEntries(
    (variables[0]?.rows ?? []).map((row) => [row.label, [...row.items].sort()]),
  );

  expect(rows).toStrictEqual({
    other: ["TOKEN"],
    tickets: ["API_KEY", "HOME", "REGION"],
    web: ["WEB_X_KEY"],
  });
});

test("mcp list and mcp show name the variables with no value here, and how to set them", async (t) => {
  const m = await machine(t, ["API_KEY"]);
  const unsetOf = (items: InventoryItem[]) =>
    Object.fromEntries(items.map((item) => [item.name, item.unsetVariables]));

  // Only asked for: reading every definition costs a request per server.
  expect(unsetOf((await inventory(m.runtime)).items)).toStrictEqual({
    tickets: undefined,
    web: undefined,
  });

  expect(
    unsetOf((await inventory(m.runtime, { checkVariables: true })).items),
  ).toStrictEqual({ tickets: ["REGION", "HOME"], web: ["WEB_X_KEY"] });

  const output: string[] = [];
  const run = (args: string[], json = false) =>
    createProgram({
      home: m.home,
      env: m.runtime.env,
      write: (line) => output.push(line),
    }).parseAsync([...args, ...(json ? ["--json"] : [])], { from: "user" });

  await run(["mcp", "list", "--installed"]);
  const listed = stripVTControlCharacters(output.join("\n"));
  expect(listed).toMatch(
    /! tickets can't use REGION, HOME: no value here\.\n\s+Fix: barndog mcp env set tickets$/m,
  );

  expect(listed).toMatch(
    /! web can't use WEB_X_KEY: no value here\.\n\s+Fix: barndog mcp env set web WEB_X_KEY/,
  );

  output.length = 0;
  await run(["mcp", "show", "tickets", "--origin", "local"]);
  const shown = stripVTControlCharacters(output.join("\n"));
  // A table of where each value comes from, and what "kept" means.
  expect(shown).toMatch(/^Variable +Value$/m);
  expect(shown).toMatch(/^API_KEY +kept by BarnDog$/m);
  expect(shown).toMatch(/^REGION +from \$REGION \(not set\)$/m);
  expect(shown).toMatch(/^HOME_DIR +from \$HOME \(not set\)$/m);
  expect(shown).toMatch(
    /BarnDog keeps these values in ~\/\.barndog\/secrets\.json/,
  );

  // One warning for both, rather than one each.
  expect(shown).toMatch(
    /! 2 variables have no value here, so tickets can't use them\.\n\s+Fix: barndog mcp env set tickets$/m,
  );

  expect(shown.match(/has no value here|have no value here/g)).toHaveLength(1);

  output.length = 0;
  await run(["mcp", "show", "web", "--origin", "local"]);
  const web = stripVTControlCharacters(output.join("\n"));
  expect(web).toMatch(
    /! WEB_X_KEY has no value here, so web can't use it\.\n\s+Fix: barndog mcp env set web WEB_X_KEY/,
  );

  // Nothing kept, so nothing to explain.
  expect(web).not.toMatch(/secrets\.json/);

  output.length = 0;
  await run(["mcp", "show", "tickets", "--origin", "local"], true);
  expect(JSON.parse(output.join("\n"))).toMatchObject({
    keptVariables: [{ variable: "API_KEY" }],
    unsetVariables: ["REGION", "HOME"],
  });
});

test("the store refuses bad names and files others can read or that are damaged", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "barndog-secrets-file-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const runtime = testRuntime(home);
  const path = barndogPaths(home).secrets;

  expect(() => assertVariableName("1BAD")).toThrow(
    /isn't an environment variable name/,
  );

  const values = { A: { value: "1" }, B: { from: "C" } };
  await changeSecrets(
    () => ({ servers: { s: values, e: {} }, unassigned: {} }),
    runtime,
  );

  expect(await readStoredSecrets(runtime)).toStrictEqual({
    version: 2,
    servers: { s: values },
    unassigned: {},
  });

  // Windows relies on the ACL set on every write, not a check on read.
  if (process.platform !== "win32") {
    await chmod(path, POSIX_MODE.regularFile);
    await expect(readStoredSecrets(runtime)).rejects.toSatisfy(
      (error: CliError) =>
        /can be read by other users/.test(error.message) &&
        error.command === `chmod 600 '${path}'`,
    );
  }

  await writeFile(path, "{", { mode: 0o600 });
  await chmod(path, 0o600);
  await expect(readStoredSecrets(runtime)).rejects.toThrow(/is damaged/);

  await rm(path);
  await mkdir(path);
  await expect(readStoredSecrets(runtime)).rejects.toThrow(
    /isn't a regular file/,
  );
});

test("a server reads a variable it was pointed at, from its own kept values or the environment", () => {
  const definition = {
    transport: "http" as const,
    url: "https://example.test/mcp",
    headers: {
      Authorization: { secretRef: "PAT" },
      "X-Team": { secretRef: "TEAM" },
    },
    authentication: "environment" as const,
    description: "",
  };

  const values = {
    PAT: { from: "GITHUB_TOKEN" },
    TEAM: { from: "TEAM_ID" },
    TEAM_ID: { value: "t-1" },
  };

  expect(applyKeptValues(definition, values)).toStrictEqual({
    definition: {
      ...definition,
      headers: {
        Authorization: { secretRef: "GITHUB_TOKEN" },
        "X-Team": { secretRef: "TEAM_ID" },
      },
    },
    kept: { TEAM_ID: "t-1" },
  });

  expect(missingValues(definition, values, {})).toStrictEqual([
    { variable: "PAT", from: "GITHUB_TOKEN" },
  ]);

  expect(
    missingValues(definition, values, { GITHUB_TOKEN: "x" }),
  ).toStrictEqual([]);

  // An empty string is a value, kept or set, not a missing one.
  expect(
    missingValues(definition, { ...values, PAT: { value: "" } }, {}),
  ).toStrictEqual([]);

  expect(missingValues(definition, values, { GITHUB_TOKEN: "" })).toStrictEqual(
    [],
  );
});

test("a value kept for a server that's gone is forgotten by its asset ID", async (t) => {
  const m = await machine(t, []);
  await changeSecrets(
    () => ({ servers: { "gone-id": { X: { value: "1" } } }, unassigned: {} }),
    m.runtime,
  );

  expect(await listKeptValues(m.runtime)).toStrictEqual([
    { server: "gone-id", assetId: "gone-id", variable: "X", writtenTo: [] },
  ]);

  await forgetMcpValue({ server: "gone-id", variable: "X" }, m.runtime);
  expect((await readStoredSecrets(m.runtime)).version).toBe(2);
  expect(await listKeptValues(m.runtime)).toStrictEqual([]);
});

test.each([
  ["a marker equals the value it hashes", "s3cret", true],
  ["and nothing else", "other", false],
])("secret values: %s", (_, actual, expected) => {
  const recorded = redacted(
    { env: { API_KEY: "s3cret", PLAIN: "s3cret-not" }, args: ["s3cret"] },
    [{ variable: "API_KEY", value: "s3cret" }],
  );

  expect(JSON.stringify(recorded)).not.toContain('"s3cret"');
  expect(recordedVariables(recorded)).toStrictEqual(["API_KEY", "API_KEY"]);
  expect(
    sameValue(
      { env: { API_KEY: actual, PLAIN: "s3cret-not" }, args: [actual] },
      recorded,
    ),
  ).toBe(expected);

  expect(sameValue(recorded, recorded)).toBe(true);
  expect(sameValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  expect(sameValue(["x"], ["x", "y"])).toBe(false);
});
