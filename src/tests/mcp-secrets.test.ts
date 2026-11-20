import {
  chmod,
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
  forgetMcpValue,
  keepMcpValue,
  listKeptValues,
} from "../features/mcps/values.js";
import {
  recordedVariables,
  redacted,
  sameValue,
} from "../features/native/secret-values.js";
import { readSecrets, updateSecrets } from "../features/secrets/index.js";
import { doctor } from "../features/doctor/index.js";
import { addMcp } from "../ui/add-mcp.js";
import type { AddContext } from "../ui/add-asset.js";
import { testRuntime } from "./runtime.js";
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
      chooseMany: vi.fn().mockResolvedValue(keep),
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

  return { home, runtime, lines, context, file };
}

test("kept values are written into every tool, and state.json records only their hashes", async (t) => {
  const m = await machine(t, ["API_KEY", "WEB_X_KEY"]);

  expect(m.context.prompts.chooseMany).toHaveBeenCalledWith(
    "Which values should BarnDog keep on this machine?",
    [
      expect.objectContaining({ value: "API_KEY", checked: true }),
      expect.objectContaining({ value: "REGION", checked: true }),
      expect.objectContaining({ value: "WEB_X_KEY", checked: true }),
    ],
  );

  const output = m.lines.join("\n");
  expect(output).toMatch(/never uploaded/);
  expect(output).toMatch(
    /Wrote the kept value of API_KEY into .*\.claude\.json for tickets/,
  );

  // REGION was left unticked, so the tools refer to the variable.
  expect(output).toMatch(/Set REGION in your environment/);

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

  // HOME_DIR is renamed, so Codex starts the launcher; it forwards only what isn't kept.
  const launched = JSON.parse(
    Buffer.from(
      String((codex.mcp_servers.tickets!.args as string[])[1]),
      "base64url",
    ).toString(),
  );

  expect(Object.keys(launched.environment).sort()).toStrictEqual([
    "HOME_DIR",
    "REGION",
  ]);

  expect(codex.mcp_servers.web).toMatchObject({
    http_headers: { "X-Key": secret },
  });

  expect(codex.mcp_servers.web).not.toHaveProperty("env_http_headers");

  // The secret is in the tools and the private store, never in state.json.
  const state = await readFile(barndogPaths(m.home).state, "utf8");
  expect(state).not.toContain(secret);
  expect(state).toMatch(/barndog-secret:API_KEY:sha256:/);
  expect(await readSecrets(m.runtime)).toStrictEqual({
    API_KEY: secret,
    WEB_X_KEY: secret,
  });

  expect(
    (await stat(barndogPaths(m.home).secrets)).mode &
      POSIX_MODE.groupAndOtherBits,
  ).toBe(0);

  // Nothing changed, so a second sync leaves every entry as it is.
  const again = await synchronize(undefined, m.runtime);
  expect(
    again.filter((e) => e.type === "native" && e.action !== "unchanged"),
  ).toStrictEqual([]);
});

test("mcp env changes a kept value, lists where it's written, and forgets it", async (t) => {
  const m = await machine(t, ["API_KEY"]);

  const changed = await keepMcpValue("API_KEY", "sk-new", m.runtime);
  expect(changed.file).toBe(barndogPaths(m.home).secrets);
  expect(
    JSON.parse(await m.file(".claude.json")).mcpServers.tickets.env.API_KEY,
  ).toBe("sk-new");

  const listed = await listKeptValues(m.runtime);
  expect(listed).toStrictEqual([
    {
      variable: "API_KEY",
      writtenTo: expect.arrayContaining([
        { file: join(m.home, ".claude.json"), server: "tickets" },
        { file: join(m.home, ".codex/config.toml"), server: "tickets" },
      ]),
    },
  ]);

  expect(JSON.stringify(listed)).not.toContain("sk-new");

  const forgotten = await forgetMcpValue("API_KEY", m.runtime);
  expect(
    forgotten.events.some(
      (e) =>
        e.type === "notice" &&
        /Removed the kept value of API_KEY from .*\.claude\.json/.test(
          e.message,
        ),
    ),
  ).toBe(true);

  expect(
    JSON.parse(await m.file(".claude.json")).mcpServers.tickets.env.API_KEY,
  ).toBe("${API_KEY}");

  await expect(forgetMcpValue("API_KEY", m.runtime)).rejects.toThrow(
    /doesn't keep a value for API_KEY/,
  );

  await expect(keepMcpValue("API_KEY", "", m.runtime)).rejects.toThrow(/empty/);
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

  expect(await readSecrets(m.runtime)).toStrictEqual({});
  const checks = await doctor(m.runtime);
  const variables = checks.filter((check) => check.name === "MCP variable");
  expect(variables.map((check) => check.fix).sort()).toStrictEqual([
    "barndog mcp env set API_KEY",
    "barndog mcp env set HOME",
    "barndog mcp env set REGION",
    "barndog mcp env set TOKEN",
    "barndog mcp env set WEB_X_KEY",
  ]);

  expect(variables.find((c) => c.fix?.endsWith("TOKEN"))?.detail).toMatch(
    /TOKEN has no value here, so other can't use it/,
  );
});

test("the store refuses bad names and files others can read or that are damaged", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "barndog-secrets-file-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const runtime = testRuntime(home);
  const path = barndogPaths(home).secrets;

  await expect(updateSecrets({ "1BAD": "x" }, runtime)).rejects.toThrow(
    /isn't an environment variable name/,
  );

  await updateSecrets({ A: "1", B: "2" }, runtime);
  await updateSecrets({ A: null }, runtime);
  expect(await readSecrets(runtime)).toStrictEqual({ B: "2" });

  // Windows relies on the ACL set on every write, not a check on read.
  if (process.platform !== "win32") {
    await chmod(path, POSIX_MODE.regularFile);
    await expect(readSecrets(runtime)).rejects.toSatisfy(
      (error: CliError) =>
        /can be read by other users/.test(error.message) &&
        error.command === `chmod 600 '${path}'`,
    );
  }

  await writeFile(path, "{", { mode: 0o600 });
  await chmod(path, 0o600);
  await expect(readSecrets(runtime)).rejects.toThrow(/is damaged/);
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
