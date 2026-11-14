import type { McpDefinition } from "@barndog-ai/api-contract";

export type Harness = "claude" | "codex" | "cursor";

type HookEvent = {
  name: string;
  /** What a matcher filters on; absent means the tool ignores matchers there. */
  matcher?: string;
};

/**
 * What BarnDog needs to recognise and install one tool's command hooks. Nothing
 * here relates one tool to another: a Hook supports a tool only when its author
 * shipped settings for it.
 */
type HookProfile = {
  /** From the tool's hook reference. Setup also accepts names not listed here. */
  events: readonly HookEvent[];
  /**
   * Repository paths that hold this tool's hook settings, matched against the
   * whole path from the repository root (`.claude/settings.json`,
   * `plugins/x/hooks/hooks.json`). `hookSettingsOwner()` in `registry.ts` reads
   * them and `src/tests/patterns.test.ts` covers them.
   */
  settings: readonly RegExp[];
  /** Variables the tool gives its own plugin hooks to find their files. */
  rootVariables: readonly string[];
  /** The user-level hook settings file BarnDog writes, relative to the home directory. */
  file: string;
  /**
   * The `version` the tool requires at the top of its hook settings file.
   * BarnDog writes it into a new file and leaves a file with another version
   * alone. Absent when the tool's file carries no version.
   */
  fileVersion?: number;
  /** The event that runs when a session starts, in the tool's own spelling. */
  sessionStart: string;
  /** One command handler, in the shape the tool's settings file and `hook.yaml` use. */
  entry: (command: string, matcher?: string) => Record<string, unknown>;
  /**
   * What a session-start command prints on stdout to add `text` to the
   * session's context.
   */
  sessionContext: (text: string) => Record<string, unknown>;
  /** Shown after adding a Hook when the tool won't run it until the user acts. */
  trustNote?: string;
};

/** How a user signs in to an MCP server that uses the tool's own OAuth. */
type McpLogin =
  /** A command to run, followed by the server's name: `claude mcp login <name>`. */
  | { command: readonly string[] }
  /** Where to sign in inside the tool, for one without a login command. */
  | { settings: string };

type McpProfile = {
  /** The user-level MCP configuration file, relative to the home directory. */
  file: string;
  /**
   * One server entry in the tool's own format. Secrets stay references to
   * local environment variables. `launcher` is BarnDog's script that starts a
   * stdio server with renamed variables, for a tool that can't rename them.
   */
  server: (
    definition: McpDefinition,
    launcher: string,
  ) => Record<string, unknown>;
  login: McpLogin;
};

/**
 * An environment variable that moves the tool's settings away from the
 * `directory` BarnDog writes to (relative to the home directory).
 */
type ConfigHome = {
  variable: string;
  directory: string;
  /**
   * Whether setting the variable to `directory` itself is harmless. False when
   * the tool also relocates files that normally sit outside the directory, as
   * Claude Code does with `~/.claude.json`.
   */
  defaultIsSupported: boolean;
};

/**
 * Everything BarnDog knows about one coding tool: detection, Skill delivery,
 * its settings files and their formats. Features read a difference between
 * tools from here instead of comparing harness IDs. skillRoot is relative to
 * the user home.
 */
export type HarnessAdapter = {
  id: Harness;
  name: string;
  skillRoot: string;
  commands: readonly string[];
  macApp: string;
  hooks: HookProfile;
  mcp: McpProfile;
  /** Absent when the tool has no such variable. */
  configHome?: ConfigHome;
};

export type DetectedHarness = {
  id: Harness;
  name: string;
  evidence: string | null;
};
