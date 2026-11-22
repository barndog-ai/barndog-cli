import type { McpDefinition } from "@barndog-ai/api-contract";

import type { DesktopApp } from "../platform.js";

/**
 * Tools that run command hooks from a settings file. The contract's Hook
 * manifests have an implementation for each of these and no other.
 */
export type HookHarness = "claude" | "codex" | "cursor";

/** Tools without command hooks, where BarnDog's own startup work runs from a plugin module. */
type PluginHarness = "opencode";

export type Harness = HookHarness | PluginHarness;

type WindowsHookShell = "bash" | "powershell";

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
  /**
   * The shell the tool runs a hook command line in on Windows, from its hook
   * reference (on macOS and Linux every tool uses `sh`).
   */
  windowsShell: WindowsHookShell;
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

/**
 * The BarnDog-owned plugin module a tool without command hooks loads by
 * itself. BarnDog's session-start work (the workspace sync and the knowledge
 * index) runs from there.
 */
type PluginProfile = {
  /** Where the tool discovers it, relative to the home directory. */
  file: string;
  /** The BarnDog entry script it imports, under `src/entry/` without `.ts`. */
  entryScript: string;
  /**
   * The module's whole text: it imports `barndog` from BarnDog's plugin entry
   * at `entry` (a file URL) and hands it `options`. Sync compares a file on
   * disk with this text to notice hand edits, so a change here makes every
   * installed copy look edited by hand.
   */
  module: (entry: string, options: Record<string, unknown>) => string;
};

/** How a user signs in to an MCP server that uses the tool's own OAuth. */
type McpLogin =
  /** A command to run, followed by the server's name: `claude mcp login <name>`. */
  | { command: readonly string[] }
  /** Where to sign in inside the tool, for one without a login command. */
  | { settings: string };

/** Variable name → value, for the MCP variables BarnDog keeps on this machine. */
export type KeptValues = Readonly<Record<string, string>>;

type McpProfile = {
  /** The user-level MCP configuration file, relative to the home directory. */
  file: string;
  /** The keys that lead to the table of servers inside `file`, such as `["mcp", "servers"]`. */
  path: readonly string[];
  /**
   * Every user-level file the tool reads servers from, relative to the home
   * directory, `file` among them. `mcp add --from` looks in each.
   */
  files: readonly string[];
  /**
   * One of the tool's own entries in the shape `mcp add --from` converts
   * (Claude Code's), for a tool whose entries are spelled differently.
   */
  imported?: (entry: Record<string, unknown>) => Record<string, unknown>;
  /**
   * One server entry in the tool's own format. A variable in `kept` (the
   * values BarnDog keeps on this machine) is written as its value, the way the
   * tool stores values it's given; every other one stays a reference to a
   * local environment variable. `platform` picks the shell for a tool that
   * starts renamed variables through one.
   */
  server: (
    definition: McpDefinition,
    kept: KeptValues,
    platform: NodeJS.Platform,
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
type AdapterBase = {
  name: string;
  skillRoot: string;
  commands: readonly string[];
  /** The desktop app whose installation counts as evidence (see `installedApplication()`). */
  desktopApp: DesktopApp;
  mcp: McpProfile;
  /** Absent when the tool has no such variable. */
  configHome?: ConfigHome;
};

export type HookAdapter = AdapterBase & {
  id: HookHarness;
  hooks: HookProfile;
  plugin?: undefined;
};

export type PluginAdapter = AdapterBase & {
  id: PluginHarness;
  hooks?: undefined;
  plugin: PluginProfile;
};

export type HarnessAdapter = HookAdapter | PluginAdapter;

/** The adapter of each tool, typed by whether it runs command hooks. */
export type Adapters = {
  [H in Harness]: H extends HookHarness ? HookAdapter : PluginAdapter;
};

export type DetectedHarness = {
  id: Harness;
  name: string;
  evidence: string | null;
};
