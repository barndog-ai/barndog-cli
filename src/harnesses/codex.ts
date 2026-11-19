import type { McpDefinition } from "@barndog-ai/api-contract";
import { hookSpecificContext, nestedHookEntry, secretRefs } from "./formats.js";
import type { HookAdapter, KeptValues } from "./types.js";

/**
 * Codex forwards variables by name (`env_vars`, `env_http_headers`) instead of
 * interpolating references. It can't give a stdio server a variable under
 * another name; BarnDog's launcher does that. A value BarnDog keeps goes in
 * `env` or `http_headers` as written, the way Codex stores values it's given.
 */
function mcpServer(
  definition: McpDefinition,
  launcher: string,
  kept: KeptValues,
): Record<string, unknown> {
  const refs = Object.entries(secretRefs(definition));
  const literal = refs.filter(([, ref]) => kept[ref.secretRef] !== undefined);
  const forwarded = refs.filter(([, ref]) => kept[ref.secretRef] === undefined);
  const values = Object.fromEntries(
    literal.map(([name, ref]) => [name, kept[ref.secretRef] ?? ""]),
  );

  const variables = forwarded.map(([, ref]) => ref.secretRef);

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

  const inline = literal.length ? { env: values } : {};
  const renamed = forwarded.some(([name, ref]) => name !== ref.secretRef);
  if (renamed) {
    // The launcher checks only the variables it forwards; kept ones arrive in `env`.
    const environment = Object.fromEntries(forwarded);

    return {
      command: process.execPath,
      args: [
        launcher,
        Buffer.from(JSON.stringify({ ...definition, environment })).toString(
          "base64url",
        ),
      ],
      ...inline,
      env_vars: variables,
    };
  }

  return {
    command: definition.command,
    args: definition.args,
    ...inline,
    env_vars: variables,
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
    login: { command: ["codex", "mcp", "login"] },
  },
  configHome: {
    variable: "CODEX_HOME",
    directory: ".codex",
    defaultIsSupported: true,
  },
};
