import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseJson } from "jsonc-parser";
import { assert, expect, test } from "vitest";

import { readSettings, saveSettings } from "../config/settings.js";
import { barndog } from "../entry/opencode-plugin.js";
import { CliError } from "../errors.js";
import { synchronize } from "../features/environment/sync.js";
import {
  addMcpServers,
  conflictingEntries,
  convertServer,
  harnessServers,
} from "../features/mcps/import.js";
import { startupEntries } from "../features/environment/own-entries.js";
import { mcpEntry } from "../features/native/adapters.js";
import {
  patchNative,
  type NativeEntry,
} from "../features/native/configuration.js";
import {
  inPluginModule,
  pluginModule,
} from "../features/native/plugin-module.js";
import { adapters, nativeFile, skillDirectory } from "../harnesses/registry.js";
import { runSetup } from "../ui/onboarding.js";
import { testRuntime } from "./runtime.js";

import type { Harness } from "../harnesses/types.js";
import type { McpDefinition } from "@barndog-ai/api-contract";
import type { RuntimeContext } from "../runtime.js";

/** An MCP entry with every variable left as a reference, as before values were kept. */
const referenceEntry = (
  harness: Harness,
  asset: { id: string; name: string },
  definition: McpDefinition,
  runtime: RuntimeContext,
) => mcpEntry(harness, { ...asset, definition }, {}, runtime);

const id = "729b9d5a-4a8c-4aa7-9b8d-975a55ac373e";
const runtime = testRuntime("/fixture");

const stdio = {
  description: "Docs",
  transport: "stdio" as const,
  command: "npx",
  args: ["-y", "docs-server"],
  environment: { API_KEY: { secretRef: "COMPANY_DOCS_TOKEN" } },
  authentication: "environment" as const,
};

test("OpenCode gets Skills, MCP servers and BarnDog's plugin under ~/.config/opencode", () => {
  // skillDirectory() resolves, which adds the drive letter on Windows.
  expect(skillDirectory("opencode", "/fixture")).toBe(
    resolve("/fixture", ".config/opencode/skills"),
  );

  expect(nativeFile("opencode", "mcp", "/fixture")).toBe(
    join("/fixture", ".config/opencode/opencode.jsonc"),
  );

  for (const kind of ["sync", "knowledge"] as const) {
    expect(nativeFile("opencode", kind, "/fixture")).toBe(
      join("/fixture", ".config/opencode/plugins/barndog.js"),
    );
  }

  expect(adapters.opencode.hooks).toBeUndefined();
});

test("OpenCode MCP entries use local/remote types, a command list and {env:} references", () => {
  expect(
    referenceEntry("opencode", { id, name: "docs" }, stdio, runtime).value,
  ).toStrictEqual({
    type: "local",
    command: ["npx", "-y", "docs-server"],
    environment: { API_KEY: "{env:COMPANY_DOCS_TOKEN}" },
  });

  expect(
    referenceEntry(
      "opencode",
      { id, name: "docs" },
      {
        description: "Docs",
        transport: "http",
        url: "https://example.org/mcp",
        headers: { Authorization: { secretRef: "DOCS_HEADER" } },
        authentication: "environment",
      },
      runtime,
    ).value,
  ).toStrictEqual({
    type: "remote",
    url: "https://example.org/mcp",
    headers: { Authorization: "{env:DOCS_HEADER}" },
  });

  expect(
    referenceEntry(
      "opencode",
      { id, name: "docs" },
      { ...stdio, args: [], environment: {} },
      runtime,
    ).value,
  ).toStrictEqual({ type: "local", command: ["npx"] });

  expect(
    referenceEntry(
      "opencode",
      { id, name: "open" },
      {
        description: "Open",
        transport: "http",
        url: "https://example.org/open",
        headers: {},
        authentication: "none",
      },
      runtime,
    ).value,
  ).toStrictEqual({ type: "remote", url: "https://example.org/open" });
});

test("OpenCode entries are read back in Claude Code's shape for mcp add --from", () => {
  const imported = adapters.opencode.mcp.imported!;

  expect(
    imported({
      type: "remote",
      url: "https://example.org/mcp",
      headers: { Authorization: "Bearer {env:TOKEN}", Retries: 3 },
      oauth: false,
    }),
  ).toStrictEqual({
    url: "https://example.org/mcp",
    headers: { Authorization: "Bearer ${TOKEN}", Retries: 3 },
  });

  expect(
    imported({ type: "remote", url: "https://example.org/mcp", oauth: {} }),
  ).toStrictEqual({ url: "https://example.org/mcp", headers: {}, oauth: true });

  expect(imported({ type: "local", command: ["server"] })).toStrictEqual({
    command: "server",
    args: [],
    env: {},
  });
});

test("OpenCode MCP servers go under mcp.servers and leave the rest of opencode.json alone", () => {
  const managed = referenceEntry(
    "opencode",
    { id, name: "docs" },
    stdio,
    runtime,
  );

  const original =
    '{\n  // Mine\n  "theme": "dark",\n  "mcp": { "servers": { "mine": { "type": "remote", "url": "https://mine.example" } } }\n}\n';

  const installed = patchNative(original, [], [managed]);
  expect(installed).toContain("// Mine");
  expect(parseJson(installed).mcp.servers.docs).toStrictEqual(managed.value);
  expect(parseJson(installed).mcp.servers.mine).toStrictEqual({
    type: "remote",
    url: "https://mine.example",
  });

  expect(parseJson(patchNative(installed, [managed], []))).toStrictEqual(
    parseJson(original),
  );

  expect(() => patchNative(installed, [], [managed])).toThrow(/didn't add/);

  const fresh = patchNative(null, [], [managed]);
  expect(parseJson(fresh)).toStrictEqual({
    mcp: { servers: { docs: managed.value } },
  });
});

test("OpenCode's startup work becomes plugin options rather than hook registrations", () => {
  const entries = startupEntries(
    {
      harnesses: ["claude", "opencode"],
      localWorkspace: { path: "/fixture/.barndog/workspace", workspaceId: id },
    },
    runtime,
    { knowledge: true },
  );

  const opencode = entries.filter((e) => e.harness === "opencode");
  expect(opencode.map((e) => [e.kind, e.key])).toStrictEqual([
    ["knowledge", "knowledge"],
    ["sync", "sync"],
  ]);

  for (const entry of opencode) {
    expect(entry.value.command).toEqual(
      expect.arrayContaining([process.execPath, "/fixture"]),
    );

    expect(entry.value.entry).toMatch(/^file:.*opencode-plugin\.js$/);
  }

  expect(opencode[0]?.value.command).toContain("opencode");
  expect(inPluginModule(opencode)).toBe(true);
  expect(inPluginModule(entries.filter((e) => e.harness === "claude"))).toBe(
    false,
  );
});

function pluginEntry(
  kind: "knowledge" | "sync",
  command: string[],
): NativeEntry {
  return {
    id: `barndog-${kind}`,
    kind,
    harness: "opencode",
    file: nativeFile("opencode", kind, "/fixture"),
    key: kind,
    value: { entry: "file:///barndog/entry/opencode-plugin.js", command },
  };
}

test("the plugin module is written whole, checked for hand edits and removed with its entries", () => {
  const sync = pluginEntry("sync", ["node", "sync.js"]);
  const knowledge = pluginEntry("knowledge", ["node", "knowledge.js"]);

  const both = [sync, knowledge];
  const written = pluginModule(null, { before: [], after: both }, "linux");
  expect(written).toContain(
    'import { barndog } from "file:///barndog/entry/opencode-plugin.js";',
  );

  expect(written).toContain(
    'export default { id: "barndog", server: barndog({"knowledge":["node","knowledge.js"],"sync":["node","sync.js"]}) };',
  );

  // Entry order doesn't change the text, so an unchanged sync rewrites nothing.
  expect(
    pluginModule(written, { before: [knowledge, sync], after: both }, "linux"),
  ).toBe(written);

  expect(
    pluginModule(written, { before: both, after: [] }, "linux"),
  ).toBeNull();

  const edited = (() => {
    try {
      pluginModule(`${written}// mine\n`, { before: both, after: [] }, "win32");
    } catch (error) {
      return error;
    }
  })();

  expect(edited).toBeInstanceOf(CliError);
  expect(edited).toMatchObject({
    message: expect.stringMatching(/changed by hand/),
    command: expect.stringMatching(/^Remove-Item /),
  });

  expect(() =>
    pluginModule(
      "export default {};\n",
      { before: [], after: [sync] },
      "linux",
    ),
  ).toThrow(/didn't write it/);
});

test("the OpenCode plugin syncs at each new session and adds the knowledge index to the system prompt", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "barndog-opencode-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));

  const log = join(folder, "log");
  const node = (code: string) => [process.execPath, "-e", code];
  const hooks = barndog({
    sync: node(
      `require("node:fs").appendFileSync(${JSON.stringify(log)}, "sync\\n")`,
    ),
    knowledge: node(
      `require("node:fs").appendFileSync(${JSON.stringify(log)}, "index\\n"); console.log("  Shared knowledge  ")`,
    ),
  })();

  await hooks.event({ event: { type: "session.idle" } });
  await hooks.event({ event: { type: "session.created" } });

  const first = { system: ["base"] };
  await hooks["experimental.chat.system.transform"]({}, first);
  const second = { system: [] as string[] };
  await hooks["experimental.chat.system.transform"]({}, second);

  expect(first.system).toStrictEqual(["base", "Shared knowledge"]);
  expect(second.system).toStrictEqual(["Shared knowledge"]);

  // The index is read once per session, the sync once per new session.
  expect(await readFile(log, "utf8")).toBe("sync\nindex\n");
});

test("a failing or missing command never breaks an OpenCode session", async () => {
  const hooks = barndog({
    knowledge: [process.execPath, "-e", "process.exit(3)"],
    sync: [join(tmpdir(), "barndog-missing-program")],
  })();

  await expect(
    hooks.event({ event: { type: "session.created" } }),
  ).resolves.toBeUndefined();

  const output = { system: [] as string[] };
  await hooks["experimental.chat.system.transform"]({}, output);
  expect(output.system).toStrictEqual([]);

  const silent = barndog({})();
  await silent.event({ event: { type: "session.created" } });
  await silent["experimental.chat.system.transform"]({}, output);
  expect(output.system).toStrictEqual([]);

  const empty = barndog({ knowledge: [] })();
  await empty["experimental.chat.system.transform"]({}, output);
  expect(output.system).toStrictEqual([]);
});

test("the written plugin module loads and hands its options to barndog()", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "barndog-opencode-module-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));

  const entry = join(folder, "entry.mjs");
  await writeFile(
    entry,
    "export const barndog = (options) => () => ({ options });\n",
  );

  const text = adapters.opencode.plugin.module(pathToFileURL(entry).href, {
    sync: ["node", "sync.js"],
  });

  await mkdir(join(folder, "plugins"));
  const module = join(folder, "plugins", "barndog.mjs");
  await writeFile(module, text);

  const loaded: unknown = await import(pathToFileURL(module).href);
  expect(loaded).toMatchObject({
    default: { id: "barndog", server: expect.any(Function) },
  });

  const { default: plugin } = loaded as {
    default: { server: () => unknown };
  };

  expect(plugin.server()).toStrictEqual({
    options: { sync: ["node", "sync.js"] },
  });
});

async function write(root: string, path: string, text: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

test("syncing a local workspace into OpenCode links Skills, writes MCP servers and the plugin, and skips Hooks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "barndog-opencode-sync-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));

  const home = join(root, "home");
  const runtime = testRuntime(home);
  await runSetup({
    runtime,
    local: true,
    restart: true,
    interactive: true,
    detected: [],
    write: () => {},
    confirmRestart: async () => true,
    confirmApply: async () => true,
    choose: async () => ["opencode"],
  });

  const settings = await readSettings(home);
  assert(settings?.localWorkspace);
  const folder = settings.localWorkspace.path;

  await write(
    folder,
    "org/skills/review/SKILL.md",
    "---\nname: review\ndescription: Reviews\n---\nBody\n",
  );

  await write(
    folder,
    "org/mcp/docs.yaml",
    "description: Docs.\ntransport: http\nurl: https://docs.example.com/mcp\nauthentication: environment\nheaders:\n  Authorization:\n    secretRef: DOCS_TOKEN\n",
  );

  await write(
    folder,
    "org/hooks/audit/hook.yaml",
    "name: audit\ndescription: Log.\nimplementations:\n  claude:\n    compatibility: supported\n    scripts: [audit.sh]\n    events:\n      Stop:\n        - hooks:\n            - command: ${BARNDOG_HOOK_ROOT}/audit.sh\n",
  );

  await write(folder, "org/hooks/audit/audit.sh", "#!/bin/sh\n");
  await write(
    folder,
    "org/knowledge/layout.md",
    "---\ndescription: Where code belongs.\naccessMode: always\n---\n# Layout\n",
  );

  const events = await synchronize(undefined, runtime);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "unsupported",
      kind: "hook",
      harness: "opencode",
      reason: "OpenCode has no command hooks",
    }),
  );

  expect(
    await readFile(
      join(home, ".config/opencode/skills/review/SKILL.md"),
      "utf8",
    ),
  ).toContain("name: review");

  const config = parseJson(
    await readFile(join(home, ".config/opencode/opencode.jsonc"), "utf8"),
  );

  expect(config.mcp.servers.docs).toStrictEqual({
    type: "remote",
    url: "https://docs.example.com/mcp",
    headers: { Authorization: "{env:DOCS_TOKEN}" },
  });

  const plugin = join(home, ".config/opencode/plugins/barndog.js");
  const text = await readFile(plugin, "utf8");
  expect(text).toContain("entry/opencode-plugin.js");
  expect(text).toContain("knowledge-startup.js");
  expect(text).toContain("workspace-startup.js");

  // A second sync leaves everything as it was.
  await synchronize(undefined, runtime);
  expect(await readFile(plugin, "utf8")).toBe(text);

  await writeFile(plugin, `${text}// mine\n`);
  await expect(synchronize(undefined, runtime)).rejects.toThrow(
    /changed by hand/,
  );

  await writeFile(plugin, text);
  await saveSettings({ ...settings, harnesses: [] }, home);
  await synchronize(undefined, runtime);
  expect(existsSync(plugin)).toBe(false);
  expect(existsSync(join(home, ".config/opencode/skills/review"))).toBe(false);
  expect(
    parseJson(
      await readFile(join(home, ".config/opencode/opencode.jsonc"), "utf8"),
    ).mcp.servers,
  ).toStrictEqual({});
});

test("mcp add --from opencode reads every OpenCode config file and takes a server over from the one it's in", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "barndog-opencode-import-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));

  const home = join(root, "home");
  const runtime = testRuntime(home);
  await runSetup({
    runtime,
    local: true,
    restart: true,
    interactive: true,
    detected: [],
    write: () => {},
    confirmRestart: async () => true,
    confirmApply: async () => true,
    choose: async () => ["opencode"],
  });

  await write(
    home,
    ".config/opencode/opencode.json",
    JSON.stringify({
      theme: "dark",
      mcp: {
        servers: {
          docs: {
            type: "local",
            command: ["npx", "-y", "docs-server"],
            environment: { API_KEY: "{env:DOCS_KEY}" },
          },
        },
      },
    }),
  );

  await write(
    home,
    ".config/opencode/config.json",
    JSON.stringify({
      mcp: {
        servers: {
          search: {
            type: "remote",
            url: "https://search.example/mcp",
            headers: { Authorization: "Bearer {env:SEARCH_TOKEN}" },
            oauth: {},
          },
        },
      },
    }),
  );

  const found = await harnessServers(runtime);
  const opencode = found.filter((s) => s.harness === "opencode");
  expect(opencode.map((s) => [s.name, s.label])).toStrictEqual([
    ["search", "OpenCode, config.json"],
    ["docs", "OpenCode, opencode.json"],
  ]);

  const docs = convertServer(opencode[1]!);
  expect(docs.definition).toMatchObject({
    transport: "stdio",
    command: "npx",
    args: ["-y", "docs-server"],
    environment: { API_KEY: { secretRef: "DOCS_KEY" } },
  });

  const search = convertServer(opencode[0]!);
  expect(search.definition).toMatchObject({
    transport: "http",
    url: "https://search.example/mcp",
    headers: { Authorization: { secretRef: "SEARCH_TOKEN" } },
    authentication: "native-oauth",
  });

  expect(await conflictingEntries("docs", runtime)).toStrictEqual([
    {
      harness: "opencode",
      file: join(home, ".config/opencode/opencode.json"),
      server: opencode[1]!.native,
    },
  ]);

  // The error names the tool, not the settings file's full path.
  await expect(addMcpServers([docs], { keep: [] }, runtime)).rejects.toThrow(
    "docs is already configured in OpenCode.",
  );

  const { backups } = await addMcpServers(
    [docs],
    { replace: true, keep: [] },
    runtime,
  );

  expect(backups).toHaveLength(1);

  const theirs = parseJson(
    await readFile(join(home, ".config/opencode/opencode.json"), "utf8"),
  );

  expect(theirs).toStrictEqual({ theme: "dark", mcp: { servers: {} } });
  const ours = parseJson(
    await readFile(join(home, ".config/opencode/opencode.jsonc"), "utf8"),
  );

  expect(ours.mcp.servers.docs).toStrictEqual({
    type: "local",
    command: ["npx", "-y", "docs-server"],
    environment: { API_KEY: "{env:DOCS_KEY}" },
  });

  // What BarnDog installed isn't offered for import again.
  expect(
    (await harnessServers(runtime)).filter((s) => s.harness === "opencode"),
  ).toMatchObject([{ name: "search" }]);
});
