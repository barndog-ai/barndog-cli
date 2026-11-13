import { expect, test } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseJson } from "jsonc-parser";
import {
  patchNative,
  nativeFile,
  type NativeEntry,
} from "../features/native/configuration.js";
import {
  locked,
  transact,
  fileText,
} from "../features/environment/transaction.js";
import { mcpEntry, hookCommand } from "../features/native/adapters.js";
import { createProgram } from "../program.js";
import { spawnSync } from "node:child_process";

const id = "729b9d5a-4a8c-4aa7-9b8d-975a55ac373e";

function entry(
  harness: "claude" | "codex" | "cursor",
  kind: "mcp" | "hook" = "mcp",
  key = "docs",
  value: Record<string, unknown> = { url: "https://example.org/mcp" },
): NativeEntry {
  return {
    id,
    harness,
    kind,
    file: nativeFile(harness, kind, "/fixture"),
    key,
    value,
  };
}

test("native MCP changes preserve unmanaged entries, credentials, settings and comments", () => {
  const original =
    '{\n // User comment\n "theme": "dark",\n "mcpServers": { "mine": { "command": "mine", "env": { "TOKEN": "local-user-secret" } } }\n}\n';
  const managed = entry("claude");
  const installed = patchNative(original, [], [managed]);
  expect(installed).toContain("// User comment");
  expect(installed).toContain(
    '"mine": { "command": "mine", "env": { "TOKEN": "local-user-secret" } }',
  );
  expect(parseJson(installed).mcpServers.mine).toStrictEqual(
    parseJson(original).mcpServers.mine,
  );
  expect(patchNative(installed, [managed], [managed])).toBe(installed);
  const updated = { ...managed, value: { url: "https://example.org/new" } };
  const changed = patchNative(installed, [managed], [updated]);
  expect(parseJson(changed).mcpServers.mine).toStrictEqual(
    parseJson(original).mcpServers.mine,
  );
  const removed = patchNative(changed, [updated], []);
  expect(parseJson(removed)).toStrictEqual(parseJson(original));
  expect(() => patchNative(installed, [], [managed])).toThrow(/unmanaged MCP/);
  expect(() =>
    patchNative(
      installed.replace(
        "https://example.org/mcp",
        "https://manual.example.org",
      ),
      [managed],
      [updated],
    ),
  ).toThrow(/changed externally/);
  expect(() => patchNative(original, [managed], [])).toThrow(
    /changed externally/,
  );
});

test("TOML edits preserve unrelated sections, header references, comments and multiline strings", () => {
  const original =
    '# My config\nmodel = "fixture-model"\nmessage = """\n[mcp_servers.fake]\nnot = a_table\n"""\n[mcp_servers.mine]\ncommand = "mine"\n# Keep this token local\n[mcp_servers.mine.env]\nTOKEN = "local-user-secret"\n[other]\nenabled = true\n';
  const managed = entry("codex", "mcp", "docs", {
    command: "node",
    args: ["a script.js"],
    env_vars: ["DOCS_TOKEN"],
  });
  const installed = patchNative(original, [], [managed]);
  expect(installed.startsWith(original.trimEnd())).toBeTruthy();
  expect(
    JSON.parse(JSON.stringify(parseToml(installed).mcp_servers)),
  ).toStrictEqual({
    mine: { command: "mine", env: { TOKEN: "local-user-secret" } },
    docs: managed.value,
  });
  const updated = {
    ...managed,
    value: {
      url: "https://example.org/mcp",
      env_http_headers: { Authorization: "DOCS_TOKEN" },
    },
  };
  const changed = patchNative(installed, [managed], [updated]);
  expect(changed).toContain('TOKEN = "local-user-secret"');
  expect(changed).toContain("# Keep this token local");
  expect(parseToml(patchNative(changed, [updated], []))).toStrictEqual(
    parseToml(original),
  );
  expect(() => patchNative(installed, [], [managed])).toThrow(/unmanaged MCP/);
  expect(() =>
    patchNative(
      installed.replace('"a script.js"', '"edited.js"'),
      [managed],
      [],
    ),
  ).toThrow(/changed externally/);
  expect(
    JSON.parse(
      JSON.stringify(parseToml(patchNative(null, [], [managed])).mcp_servers),
    ),
  ).toStrictEqual({ docs: managed.value });
});

test("Hook array reconciliation preserves unmanaged registrations and detects edits", () => {
  const original = JSON.stringify({
    version: 1,
    hooks: { sessionStart: [{ command: "my-own-hook" }] },
    telemetry: false,
  });
  const first = entry("cursor", "hook", "sessionStart", {
    command: "barndog-owned-hook",
  });
  const second = entry("cursor", "hook", "afterFileEdit", {
    command: "second-owned-hook",
  });
  const installed = patchNative(original, [], [first, second]);
  expect(parseJson(installed).hooks.sessionStart[0]).toStrictEqual({
    command: "my-own-hook",
  });
  expect(patchNative(installed, [first, second], [first, second])).toBe(
    installed,
  );
  expect(parseJson(patchNative(installed, [first, second], []))).toStrictEqual(
    parseJson(original),
  );
  expect(() =>
    patchNative(
      installed.replace("barndog-owned-hook", "manual-edit"),
      [first, second],
      [],
    ),
  ).toThrow(/changed externally/);
  expect(() => patchNative(installed, [], [first])).toThrow(/unmanaged Hook/);
});

test("MCP adapters retain secret references and support Codex environment aliases", () => {
  const definition = {
    description: "Docs",
    transport: "stdio" as const,
    command: "node",
    args: ["server.js"],
    environment: { API_KEY: { secretRef: "COMPANY_DOCS_TOKEN" } },
    authentication: "environment" as const,
  };
  for (const harness of ["claude", "codex", "cursor"] as const) {
    const result = mcpEntry(
      harness,
      { id, name: "docs" },
      definition,
      "/fixture",
    );
    if (harness === "codex") {
      expect(result.value.command).toBe(process.execPath);
      expect(result.value.env_vars).toStrictEqual(["COMPANY_DOCS_TOKEN"]);
    } else
      expect(result.value.env).toStrictEqual({
        API_KEY:
          harness === "cursor"
            ? "${env:COMPANY_DOCS_TOKEN}"
            : "${COMPANY_DOCS_TOKEN}",
      });
  }
});

test("Hook root binding preserves author quoting and paths containing spaces and quotes", () => {
  const root = "/tmp/a folder's package";
  const result = spawnSync(
    "/bin/sh",
    [
      "-c",
      hookCommand(root, 'printf "%s" "${BARNDOG_HOOK_ROOT}/scripts/check.sh"'),
    ],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(`${root}/scripts/check.sh`);
});

test("interrupted native writes roll forward and refuse to overwrite later user changes", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "barndog-transaction-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const a = nativeFile("claude", "mcp", home),
    b = nativeFile("cursor", "mcp", home);
  await expect(
    locked(home, () =>
      transact(
        home,
        [
          { kind: "file", path: a, before: null, after: '{"mcpServers":{}}' },
          { kind: "file", path: b, before: null, after: '{"mcpServers":{}}' },
        ],
        undefined,
        async (index) => {
          if (!index) throw new Error("interrupted");
        },
      ),
    ),
  ).rejects.toThrow(/interrupted/);
  expect(await fileText(a)).not.toBe(null);
  expect(await fileText(b)).toBe(null);
  await writeFile(a, '{"mcpServers":{},"userSetting":true}');
  await expect(locked(home, async () => undefined)).rejects.toThrow(
    /changed.*recovery/,
  );
  expect(await fileText(a)).toBe('{"mcpServers":{},"userSetting":true}');
  expect(await fileText(b)).toBe(null);
  await writeFile(a, '{"mcpServers":{}}');
  await locked(home, async () => undefined);
  expect(await fileText(b)).toBe('{"mcpServers":{}}');
  expect(await fileText(join(home, ".barndog/pending-sync.json"))).toBe(null);
});

test("command parsing delegates scope, native and mirror operations", async () => {
  const calls: unknown[] = [];
  // The command only prints what comes back, so the result's shape isn't under test.
  const record = (name: string) => async (options: unknown) => {
    calls.push([name, options]);
    return { message: "ok" } as never;
  };
  const make = () =>
    createProgram({
      write: () => undefined,
      switchSet: async (options) => {
        calls.push(["switch", options]);
        return { status: "applied", events: [] };
      },
      changeAsset: async (change, target) => {
        calls.push([change, target]);
        return { status: "applied", events: [] };
      },
      githubResolveMirror: record("resolve-mirror"),
      githubImportCopy: record("import-copy"),
      githubCreateRepository: record("create-repository"),
    });
  await make().parseAsync(
    [
      "sets",
      "switch-team",
      "platform",
      "--mode",
      "all",
      "--overrides",
      "preserve",
    ],
    { from: "user" },
  );
  await make().parseAsync(
    ["mcp", "install", "docs", "--origin", "team/platform"],
    { from: "user" },
  );
  await make().parseAsync(
    [
      "github",
      "resolve-mirror",
      id,
      "--action",
      "disconnect",
      "--expected-version",
      id,
      "--expected-remote",
      "absent",
    ],
    { from: "user" },
  );
  await make().parseAsync(
    [
      "github",
      "import",
      "guide",
      "--origin",
      "org",
      "--installation",
      id,
      "--repository",
      "acme/guide",
      "--authority",
      "barndog",
      "--key",
      "copy-key",
    ],
    { from: "user" },
  );
  await make().parseAsync(
    [
      "github",
      "create-repository",
      "guide",
      "--origin",
      "org",
      "--installation",
      id,
      "--repository",
      "acme/new-guide",
      "--expected-version",
      id,
      "--key",
      "create-key",
      "--visibility",
      "public",
    ],
    { from: "user" },
  );
  expect(calls[3]).toStrictEqual([
    "import-copy",
    {
      kind: "skill",
      name: "guide",
      origin: "org",
      installation: id,
      repository: "acme/guide",
      key: "copy-key",
    },
  ]);
  expect(calls[4]).toStrictEqual([
    "create-repository",
    {
      kind: "skill",
      name: "guide",
      origin: "org",
      installation: id,
      repository: "acme/new-guide",
      expectedVersion: id,
      key: "create-key",
      mode: "mirror",
      visibility: "public",
    },
  ]);
  expect(calls[0]).toStrictEqual([
    "switch",
    {
      origin: "team/platform",
      mode: "all",
      overrides: "preserve",
      resolution: undefined,
    },
  ]);
  expect(calls[1]).toStrictEqual([
    "install",
    {
      kind: "mcp",
      name: "docs",
      origin: "team/platform",
      resolution: undefined,
    },
  ]);
  expect(calls[2]).toStrictEqual([
    "resolve-mirror",
    {
      connectionId: id,
      action: "disconnect",
      expectedVersion: id,
      expectedRemoteCommit: null,
    },
  ]);
});

test("owned Hook removal retains adjacent unmanaged comments and trailing-comma JSONC", () => {
  const managed = entry("claude", "hook", "SessionStart", {
    hooks: [{ type: "command", command: "owned" }],
  });
  const original =
    '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"unmanaged"}]}, /* keep this comment */ {"hooks":[{"type":"command","command":"owned"}]},]}}';
  const removed = patchNative(original, [managed], []);
  expect(removed).toContain("/* keep this comment */");
  expect(parseJson(removed).hooks.SessionStart[0].hooks[0].command).toBe(
    "unmanaged",
  );
  const only =
    '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"owned"}]},]}}';
  expect(parseJson(patchNative(only, [managed], []))).toStrictEqual({
    hooks: {},
  });
});
