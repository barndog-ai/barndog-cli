import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  readlink,
  realpath,
} from "node:fs/promises";
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
import { synchronize } from "../features/environment/sync.js";
import { mcpEntry, hookCommand } from "../features/native/adapters.js";
import { selectionState, withSelection } from "../config/environment.js";
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
  assert.ok(installed.includes("// User comment"));
  assert.ok(
    installed.includes(
      '"mine": { "command": "mine", "env": { "TOKEN": "local-user-secret" } }',
    ),
  );
  assert.deepEqual(
    parseJson(installed).mcpServers.mine,
    parseJson(original).mcpServers.mine,
  );
  assert.equal(patchNative(installed, [managed], [managed]), installed);
  const updated = { ...managed, value: { url: "https://example.org/new" } };
  const changed = patchNative(installed, [managed], [updated]);
  assert.deepEqual(
    parseJson(changed).mcpServers.mine,
    parseJson(original).mcpServers.mine,
  );
  const removed = patchNative(changed, [updated], []);
  assert.deepEqual(parseJson(removed), parseJson(original));
  assert.throws(() => patchNative(installed, [], [managed]), /unmanaged MCP/);
  assert.throws(
    () =>
      patchNative(
        installed.replace(
          "https://example.org/mcp",
          "https://manual.example.org",
        ),
        [managed],
        [updated],
      ),
    /changed externally/,
  );
  assert.throws(
    () => patchNative(original, [managed], []),
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
  assert.ok(installed.startsWith(original.trimEnd()));
  assert.deepEqual(
    JSON.parse(JSON.stringify(parseToml(installed).mcp_servers)),
    {
      mine: { command: "mine", env: { TOKEN: "local-user-secret" } },
      docs: managed.value,
    },
  );
  const updated = {
    ...managed,
    value: {
      url: "https://example.org/mcp",
      env_http_headers: { Authorization: "DOCS_TOKEN" },
    },
  };
  const changed = patchNative(installed, [managed], [updated]);
  assert.ok(changed.includes('TOKEN = "local-user-secret"'));
  assert.ok(changed.includes("# Keep this token local"));
  assert.deepEqual(
    parseToml(patchNative(changed, [updated], [])),
    parseToml(original),
  );
  assert.throws(() => patchNative(installed, [], [managed]), /unmanaged MCP/);
  assert.throws(
    () =>
      patchNative(
        installed.replace('"a script.js"', '"edited.js"'),
        [managed],
        [],
      ),
    /changed externally/,
  );
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(parseToml(patchNative(null, [], [managed])).mcp_servers),
    ),
    { docs: managed.value },
  );
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
  assert.deepEqual(parseJson(installed).hooks.sessionStart[0], {
    command: "my-own-hook",
  });
  assert.equal(
    patchNative(installed, [first, second], [first, second]),
    installed,
  );
  assert.deepEqual(
    parseJson(patchNative(installed, [first, second], [])),
    parseJson(original),
  );
  assert.throws(
    () =>
      patchNative(
        installed.replace("barndog-owned-hook", "manual-edit"),
        [first, second],
        [],
      ),
    /changed externally/,
  );
  assert.throws(() => patchNative(installed, [], [first]), /unmanaged Hook/);
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
      assert.equal(result.value.command, process.execPath);
      assert.deepEqual(result.value.env_vars, ["COMPANY_DOCS_TOKEN"]);
    } else
      assert.deepEqual(result.value.env, {
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
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${root}/scripts/check.sh`);
});

test("selection migration preserves independent choices and local sources", () => {
  const previous = {
    version: 2 as const,
    harnesses: ["claude" as const],
    connection: {
      server: "https://example.org",
      organizationId: id,
      developerId: id,
    },
    skills: [
      { kind: "api" as const, id, enabled: false },
      {
        kind: "local" as const,
        id: "829b9d5a-4a8c-4aa7-9b8d-975a55ac373e",
        source: "/my/skill",
        enabled: true,
      },
    ],
  };
  const state = selectionState(previous),
    migrated = withSelection(previous, state);
  assert.deepEqual(state.individualAssetIds, [id]);
  assert.deepEqual(state.disabledAssetIds, [id]);
  assert.deepEqual(migrated.skills, previous.skills.slice(1));
  assert.deepEqual(migrated.connection, previous.connection);
});

test("interrupted native writes roll forward and refuse to overwrite later user changes", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "barndog-transaction-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const a = nativeFile("claude", "mcp", home),
    b = nativeFile("cursor", "mcp", home);
  await assert.rejects(
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
    /interrupted/,
  );
  assert.notEqual(await fileText(a), null);
  assert.equal(await fileText(b), null);
  await writeFile(a, '{"mcpServers":{},"userSetting":true}');
  await assert.rejects(
    locked(home, async () => undefined),
    /changed.*recovery/,
  );
  assert.equal(await fileText(a), '{"mcpServers":{},"userSetting":true}');
  assert.equal(await fileText(b), null);
  await writeFile(a, '{"mcpServers":{}}');
  await locked(home, async () => undefined);
  assert.equal(await fileText(b), '{"mcpServers":{}}');
  assert.equal(await fileText(join(home, ".barndog/pending-sync.json")), null);
});

test("unified delivery refuses unmanaged links and only unlinks managed Skills", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "barndog-unified-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = join(home, "source/example");
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, "SKILL.md"),
    "---\nname: example\ndescription: Example\n---\nInstructions\n",
  );
  const settings = {
    version: 1 as const,
    harnesses: ["claude" as const],
    skills: [{ id, source, enabled: true }],
  };
  await synchronize(undefined, home, settings);
  assert.equal(
    await readlink(join(home, ".claude/skills/example")),
    await realpath(source),
  );
  await synchronize(undefined, home, { ...settings, skills: [] });
  assert.ok(await readFile(join(source, "SKILL.md"), "utf8"));
  await symlink(source, join(home, ".claude/skills/example"));
  await assert.rejects(
    synchronize(undefined, home, settings),
    /unmanaged Skill/,
  );
});

test("command parsing delegates scope, native and mirror operations", async () => {
  const calls: unknown[] = [];
  const make = () =>
    createProgram({
      write: () => undefined,
      environment: async (action, options) => {
        calls.push([action, options]);
        return { status: "applied", events: [] };
      },
      capability: async (action, options) => {
        calls.push([action, options]);
        return { message: "ok" };
      },
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
  assert.equal((calls[3] as [string])[0], "github-import");
  assert.equal((calls[4] as [string])[0], "github-create-repository");
  assert.deepEqual(calls[0], [
    "switch",
    { origin: "team/platform", mode: "all", overrides: "preserve" },
  ]);
  assert.deepEqual(calls[1], [
    "install",
    { kind: "mcp", name: "docs", origin: "team/platform" },
  ]);
  assert.equal((calls[2] as [string])[0], "github-mirror-resolve");
});

test("owned Hook removal retains adjacent unmanaged comments and trailing-comma JSONC", () => {
  const managed = entry("claude", "hook", "SessionStart", {
    hooks: [{ type: "command", command: "owned" }],
  });
  const original =
    '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"unmanaged"}]}, /* keep this comment */ {"hooks":[{"type":"command","command":"owned"}]},]}}';
  const removed = patchNative(original, [managed], []);
  assert.ok(removed.includes("/* keep this comment */"));
  assert.equal(
    parseJson(removed).hooks.SessionStart[0].hooks[0].command,
    "unmanaged",
  );
  const only =
    '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"owned"}]},]}}';
  assert.deepEqual(parseJson(patchNative(only, [managed], [])), { hooks: {} });
});
