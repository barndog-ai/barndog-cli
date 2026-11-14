import type { McpDefinition } from "@barndog-ai/api-contract";
import { hookSpecificContext, nestedHookEntry, secretRefs } from "./formats.js";
import type { HarnessAdapter } from "./types.js";

/**
 * Codex forwards variables by name (`env_vars`, `env_http_headers`) instead of
 * interpolating references, so secrets stay out of `config.toml`. It can't give
 * a stdio server a variable under another name; BarnDog's launcher does that.
 */
function mcpServer(
  definition: McpDefinition,
  launcher: string,
): Record<string, unknown> {
  const refs = secretRefs(definition);
  const variables = Object.values(refs).map((ref) => ref.secretRef);

  if (definition.transport === "http") {
    return {
      url: definition.url,
      ...(variables.length
        ? {
            env_http_headers: Object.fromEntries(
              Object.entries(refs).map(([name, ref]) => [name, ref.secretRef]),
            ),
          }
        : {}),
    };
  }

  const renamed = Object.entries(refs).some(
    ([name, ref]) => name !== ref.secretRef,
  );

  if (renamed) {
    return {
      command: process.execPath,
      args: [
        launcher,
        Buffer.from(JSON.stringify(definition)).toString("base64url"),
      ],
      env_vars: variables,
    };
  }

  return {
    command: definition.command,
    args: definition.args,
    env_vars: variables,
  };
}

const toolMatcher =
  "Tool name, such as Bash or Edit|Write. Leave empty for all";

export const codex: HarnessAdapter = {
  id: "codex",
  name: "Codex",
  skillRoot: ".agents/skills",
  commands: ["codex"],
  macApp: "Codex.app",
  hooks: {
    settings: [/(^|\/)\.codex\/hooks\.json$/, /(^|\/)\.codex\/config\.toml$/],
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
    server: mcpServer,
    login: { command: ["codex", "mcp", "login"] },
  },
  configHome: {
    variable: "CODEX_HOME",
    directory: ".codex",
    defaultIsSupported: true,
  },
};
