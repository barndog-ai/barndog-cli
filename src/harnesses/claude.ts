import {
  hookSpecificContext,
  jsonMcpServer,
  nestedHookEntry,
} from "./formats.js";
import type { HookAdapter } from "./types.js";

const toolMatcher =
  "Tool name, such as Bash or Edit|Write. Leave empty for all";

export const claude: HookAdapter = {
  id: "claude",
  name: "Claude Code",
  skillRoot: ".claude/skills",
  commands: ["claude"],
  desktopApp: { name: "Claude" },
  hooks: {
    settings: [
      /(^|\/)\.claude\/settings(\.local)?\.json$/,
      /(^|\/)hooks\/hooks\.json$/,
    ],
    // Git Bash, as Claude Code's hook reference says (PowerShell only when Git Bash is missing).
    windowsShell: "bash",
    rootVariables: ["CLAUDE_PLUGIN_ROOT"],
    file: ".claude/settings.json",
    sessionStart: "SessionStart",
    entry: nestedHookEntry,
    sessionContext: hookSpecificContext,
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
        name: "PostToolUseFailure",
        matcher: toolMatcher,
      },
      {
        name: "PermissionRequest",
        matcher: toolMatcher,
      },
      {
        name: "Notification",
        matcher: "Notification type",
      },
      {
        name: "SubagentStart",
        matcher: "Agent type",
      },
      { name: "SubagentStop", matcher: "Agent type" },
      { name: "Stop" },
      { name: "PreCompact", matcher: "manual or auto" },
      {
        name: "PostCompact",
        matcher: "manual or auto",
      },
      {
        name: "SessionEnd",
        matcher: "Why the session ended",
      },
    ],
  },
  mcp: {
    file: ".claude.json",
    files: [".claude.json"],
    path: ["mcpServers"],
    server: (definition, kept) =>
      jsonMcpServer(
        definition,
        {
          reference: (variable) => `\${${variable}}`,
          typed: true,
        },
        kept,
      ),
    login: { command: ["claude", "mcp", "login"] },
  },
  configHome: {
    variable: "CLAUDE_CONFIG_DIR",
    directory: ".claude",
    defaultIsSupported: false,
  },
};
