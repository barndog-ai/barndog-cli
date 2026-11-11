import type { HarnessAdapter } from "./types.js";

const toolMatcher =
  "Tool name, such as Bash or Edit|Write. Leave empty for all";

export const claude: HarnessAdapter = {
  id: "claude",
  name: "Claude Code",
  skillRoot: ".claude/skills",
  commands: ["claude"],
  macApp: "Claude.app",
  hooks: {
    settings: [
      /(^|\/)\.claude\/settings(\.local)?\.json$/,
      /(^|\/)hooks\/hooks\.json$/,
    ],
    rootVariables: ["CLAUDE_PLUGIN_ROOT"],
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
};
