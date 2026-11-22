import type { McpDefinition } from "@barndog-ai/api-contract";
import { hookSpecificContext, nestedHookEntry, secretRefs } from "./formats.js";
import type { HookAdapter, KeptValues } from "./types.js";
import { renamedVariablesOf } from "./read-renamed-variables.js";
import { withRenamedVariables } from "./renamed-variables.js";
import { asRecord, asStrings } from "../shared/values.js";

/**
 * Codex forwards variables by name (`env_vars`, `env_http_headers`) instead of
 * interpolating references. It can't give a stdio server a variable under
 * another name, so such a server starts through the system shell, which
 * renames them (`renamed-variables.ts`). A value BarnDog keeps goes in `env` or
 * `http_headers` as written, the way Codex stores values it's given.
 */
function mcpServer(
  definition: McpDefinition,
  kept: KeptValues,
  platform: NodeJS.Platform,
): Record<string, unknown> {
  const refs = Object.entries(secretRefs(definition));
  const literal = refs.filter(([, ref]) => kept[ref.secretRef] !== undefined);
  const forwarded = refs.filter(([, ref]) => kept[ref.secretRef] === undefined);
  const values = Object.fromEntries(
    literal.map(([name, ref]) => [name, kept[ref.secretRef] ?? ""]),
  );

  const variables = [...new Set(forwarded.map(([, ref]) => ref.secretRef))];

  if (definition.transport === "http") {
    return {
      url: definition.url,
      ...(literal.length ? { http_headers: values } : {}),
      ...(forwarded.length
        ? {
            env_http_headers: Object.fromEntries(
              forwarded.map(([name, ref]) => [name, ref.secretRef]),
            ),
          }
        : {}),
    };
  }

  const renamed = forwarded
    .filter(([name, ref]) => name !== ref.secretRef)
    .map(([name, ref]) => ({ name, from: ref.secretRef }));

  const server = { command: definition.command, args: definition.args };

  return {
    ...(renamed.length
      ? withRenamedVariables(server, renamed, platform)
      : server),
    ...(literal.length ? { env: values } : {}),
    env_vars: variables,
  };
}

/**
 * A Codex entry for `mcp add --from` and `adopt`, with a renaming wrapper
 * (which sync wrote, and `uninstall --keep-setup` left behind) read back as
 * the server it starts and a reference per renamed variable. The wrapper
 * lists each source variable in `env_vars` to rename it, so those are
 * dropped. A definition that also passed a source on under its own name
 * can't be told apart from the entry, and comes back without that variable.
 */
function importedServer(
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const wrapped =
    typeof entry.command === "string"
      ? renamedVariablesOf({
          command: entry.command,
          args: asStrings(entry.args),
        })
      : undefined;

  if (!wrapped) {
    return entry;
  }

  const sources = new Set(wrapped.renamed.map(({ from }) => from));

  return {
    ...entry,
    ...wrapped.server,
    env: {
      ...asRecord(entry.env),
      ...Object.fromEntries(
        wrapped.renamed.map(({ name, from }) => [name, `\${${from}}`]),
      ),
    },
    env_vars: asStrings(entry.env_vars).filter((name) => !sources.has(name)),
  };
}

const toolMatcher =
  "Tool name, such as Bash or Edit|Write. Leave empty for all";

export const codex: HookAdapter = {
  id: "codex",
  name: "Codex",
  skillRoot: ".agents/skills",
  commands: ["codex"],
  desktopApp: { name: "Codex" },
  hooks: {
    settings: [/(^|\/)\.codex\/hooks\.json$/, /(^|\/)\.codex\/config\.toml$/],
    // Recent Codex runs hooks in the session shell, PowerShell on Windows;
    // older releases (such as 0.142) used cmd.exe, where these lines fail.
    windowsShell: "powershell",
    rootVariables: ["PLUGIN_ROOT"],
    file: ".codex/hooks.json",
    sessionStart: "SessionStart",
    entry: nestedHookEntry,
    sessionContext: hookSpecificContext,
    trustNote: "Codex skips new Hooks until you trust them with /hooks.",
    events: [
      {
        name: "SessionStart",
        matcher: "startup, resume, clear, compact or fork",
      },
      { name: "UserPromptSubmit" },
      {
        name: "PreToolUse",
        matcher: toolMatcher,
      },
      {
        name: "PostToolUse",
        matcher: toolMatcher,
      },
      {
        name: "PermissionRequest",
        matcher: toolMatcher,
      },
      {
        name: "SubagentStart",
        matcher: "Subagent type",
      },
      {
        name: "SubagentStop",
        matcher: "Subagent type",
      },
      { name: "Stop" },
      { name: "PreCompact", matcher: "manual or auto" },
      {
        name: "PostCompact",
        matcher: "manual or auto",
      },
      { name: "SessionEnd" },
    ],
  },
  mcp: {
    file: ".codex/config.toml",
    files: [".codex/config.toml"],
    path: ["mcp_servers"],
    server: mcpServer,
    imported: importedServer,
    login: { command: ["codex", "mcp", "login"] },
  },
  configHome: {
    variable: "CODEX_HOME",
    directory: ".codex",
    defaultIsSupported: true,
  },
};
