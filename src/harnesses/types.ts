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
};

/**
 * Tool metadata for detection, Skill delivery and Hook imports; skillRoot is
 * relative to the user home.
 */
export type HarnessAdapter = {
  id: Harness;
  name: string;
  skillRoot: string;
  commands: readonly string[];
  macApp: string;
  hooks: HookProfile;
};

export type DetectedHarness = {
  id: Harness;
  name: string;
  evidence: string | null;
};
