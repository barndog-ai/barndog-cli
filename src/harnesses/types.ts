export type Harness = "claude" | "codex" | "cursor";

export type HookEvent = {
  name: string;
  /** What a matcher filters on; absent means the tool ignores matchers there. */
  matcher?: string;
};

/**
 * What BarnDog needs to recognise and install one tool's command hooks. Nothing
 * here relates one tool to another: a Hook supports a tool only when its author
 * shipped settings for it.
 */
export type HookProfile = {
  /** From the tool's hook reference. Setup also accepts names not listed here. */
  events: readonly HookEvent[];
  /** Files in a repository that hold this tool's hook settings. */
  settings: readonly RegExp[];
  /** Variables the tool gives its own plugin hooks to find their files. */
  rootVariables: readonly string[];
};

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
