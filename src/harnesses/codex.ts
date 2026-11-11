import type { HarnessAdapter } from "./types.js";

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
};
