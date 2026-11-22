import type { McpDefinition } from "@barndog-ai/api-contract";
import { VARIABLE_NAME } from "../shared/patterns.js";
import { asRecord, asStrings } from "../shared/values.js";
import { valuesOrReferences } from "./formats.js";
import type { KeptValues, PluginAdapter } from "./types.js";

/**
 * OpenCode's server entry (`mcp.servers.<name>` in opencode.jsonc): a stdio
 * server is `local` with the program and its arguments in one `command` list,
 * an HTTP server is `remote`. Values refer to a local variable as `{env:NAME}`.
 */
function mcpServer(
  definition: McpDefinition,
  kept: KeptValues,
): Record<string, unknown> {
  const references = valuesOrReferences(
    definition,
    kept,
    (variable) => `{env:${variable}}`,
  );

  const some = Object.keys(references).length > 0;

  if (definition.transport === "http") {
    return {
      type: "remote",
      url: definition.url,
      ...(some ? { headers: references } : {}),
    };
  }

  return {
    type: "local",
    command: [definition.command, ...definition.args],
    ...(some ? { environment: references } : {}),
  };
}

/** OpenCode's reference to a local variable inside a value: `Bearer {env:TOKEN}`. */
const OPENCODE_REFERENCE = new RegExp(
  String.raw`\{env:(${VARIABLE_NAME.source})\}`,
  "g",
);

/**
 * A value with OpenCode's `{env:NAME}` references spelled `${NAME}`, as
 * Claude Code writes them: `Bearer {env:TOKEN}` → `Bearer ${TOKEN}`.
 *
 * @internal Exported for its table test in `src/tests/patterns.test.ts`.
 */
export const bracedReferences = (value: string) =>
  value.replaceAll(OPENCODE_REFERENCE, (_, name: string) => `\${${name}}`);

/** Every string value of a map, with its references respelled. */
const respelled = (values: unknown) =>
  Object.fromEntries(
    Object.entries(asRecord(values)).map(([key, value]) => [
      key,
      typeof value === "string" ? bracedReferences(value) : value,
    ]),
  );

/**
 * An OpenCode entry in Claude Code's shape. A remote server with an `oauth`
 * object signs in; `oauth: false` or none leaves that to its headers.
 */
function importedServer(
  entry: Record<string, unknown>,
): Record<string, unknown> {
  if (entry.type === "remote") {
    return {
      url: entry.url,
      headers: respelled(entry.headers),
      ...(entry.oauth ? { oauth: true } : {}),
    };
  }

  const [command, ...args] = asStrings(entry.command);

  return { command, args, env: respelled(entry.environment) };
}

/**
 * OpenCode keeps its user settings in `~/.config/opencode` on every platform
 * (or under `XDG_CONFIG_HOME`). It has no command hooks: BarnDog's
 * session-start work runs from a plugin module OpenCode loads from
 * `plugins/`, and Hook assets don't apply to it.
 */
export const opencode: PluginAdapter = {
  id: "opencode",
  name: "OpenCode",
  skillRoot: ".config/opencode/skills",
  commands: ["opencode"],
  // OpenCode Desktop's electron-builder build: OpenCode.app; a per-user NSIS
  // install, whose folder is the package name `@opencode-ai/desktop` with the
  // slash dropped; and deb/rpm packages whose entry is named after the app ID.
  desktopApp: {
    name: "OpenCode",
    windowsFolder: "@opencode-aidesktop",
    linuxEntry: "ai.opencode.desktop",
  },
  plugin: {
    file: ".config/opencode/plugins/barndog.js",
    entryScript: "opencode-plugin",
    // OpenCode's plugin loader takes a default export of `{ id, server }`.
    module: (entry, options) =>
      [
        "// Written by barndog sync, which rewrites or removes it. Sync stops if this file is edited by hand.",
        `import { barndog } from ${JSON.stringify(entry)};`,
        "",
        `export default { id: "barndog", server: barndog(${JSON.stringify(options)}) };`,
        "",
      ].join("\n"),
  },
  mcp: {
    // The file OpenCode creates on first run and reads last, so it wins.
    file: ".config/opencode/opencode.jsonc",
    // Known limitation: BarnDog supports only the latest OpenCode, so it reads
    // and writes `mcp.servers` alone. OpenCode still accepts a server written
    // straight under `mcp` (the older shape), and BarnDog neither imports those
    // nor notices one with the same name as a server it installs.
    path: ["mcp", "servers"],
    // OpenCode merges these in this order, a later file winning.
    files: [
      ".config/opencode/config.json",
      ".config/opencode/opencode.json",
      ".config/opencode/opencode.jsonc",
    ],
    server: mcpServer,
    imported: importedServer,
    login: { command: ["opencode", "mcp", "auth"] },
  },
  configHome: {
    variable: "XDG_CONFIG_HOME",
    directory: ".config",
    defaultIsSupported: true,
  },
};
