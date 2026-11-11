import type { HarnessAdapter } from "./types.js";

const toolMatcher = "Tool type, such as Shell, Read or Write";

export const cursor: HarnessAdapter = {
  id: "cursor",
  name: "Cursor",
  skillRoot: ".cursor/skills",
  commands: ["cursor", "cursor-agent"],
  macApp: "Cursor.app",
  hooks: {
    settings: [
      /(^|\/)\.cursor\/hooks\.json$/,
      /(^|\/)hooks\/hooks-cursor\.json$/,
    ],
    rootVariables: ["CURSOR_PLUGIN_ROOT"],
    events: [
      { name: "sessionStart" },
      { name: "sessionEnd" },
      { name: "beforeSubmitPrompt" },
      {
        name: "preToolUse",
        matcher: toolMatcher,
      },
      {
        name: "postToolUse",
        matcher: toolMatcher,
      },
      { name: "beforeShellExecution", matcher: "Regex for the command" },
      { name: "afterShellExecution", matcher: "Regex for the command" },
      { name: "beforeMCPExecution" },
      { name: "afterMCPExecution" },
      { name: "beforeReadFile" },
      { name: "afterFileEdit" },
      {
        name: "subagentStart",
        matcher: "Subagent type",
      },
      {
        name: "subagentStop",
        matcher: "Subagent type",
      },
      { name: "preCompact" },
      { name: "stop" },
    ],
  },
};
