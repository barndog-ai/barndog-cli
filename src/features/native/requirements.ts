import type { RuntimeContext } from "../../runtime.js";
import { coerce, satisfies, validRange } from "semver";
import {
  programOutput,
  findExecutable,
  runtimeExecutable,
} from "../../platform.js";
import { adapters } from "../../harnesses/registry.js";
import type { Harness } from "../../harnesses/types.js";

/** A `--version` answer is one short line; anything slower or longer is broken. */
const VERSION_TIMEOUT_MS = 5000;
const VERSION_OUTPUT_LIMIT_BYTES = 4096;

/**
 * Something a Hook's implementation for one tool declares it needs
 * (`requirements` in `hook.yaml`) that this machine doesn't have.
 */
export type MissingRequirement =
  /** A program named in `requirements.commands` isn't on PATH. */
  | { type: "command"; command: string }
  /** `requirements.harnessVersion` isn't a semver range: the author's mistake. */
  | { type: "invalid-range"; range: string }
  /** The tool's own command isn't on PATH, so its version can't be read. */
  | { type: "tool-missing"; range: string }
  /** The tool's `--version` failed or printed no version. */
  | { type: "version-unknown"; range: string }
  | { type: "version"; range: string; installed: string };

/** `requirements` of one implementation in `hook.yaml`. */
export type HookRequirements = { commands: string[]; harnessVersion?: string };

/** The tool's own version, or why it couldn't be read. */
async function toolVersion(
  harness: Harness,
  range: string,
  runtime: RuntimeContext,
): Promise<string | MissingRequirement> {
  const command = (
    await Promise.all(
      adapters[harness].commands.map((c) => findExecutable(c, runtime)),
    )
  ).find(Boolean);

  if (!command) {
    return { type: "tool-missing", range };
  }

  try {
    const stdout = await programOutput(command, ["--version"], runtime, {
      timeoutMs: VERSION_TIMEOUT_MS,
      maxBytes: VERSION_OUTPUT_LIMIT_BYTES,
    });

    return coerce(stdout)?.version ?? { type: "version-unknown", range };
  } catch {
    return { type: "version-unknown", range };
  }
}

/**
 * Checks required executables and optionally runs the harness version command;
 * returns every requirement this machine misses, in the order declared.
 */
export async function missingRequirements(
  harness: Harness,
  requirements: HookRequirements,
  runtime: RuntimeContext,
): Promise<MissingRequirement[]> {
  const missing: MissingRequirement[] = [];
  for (const command of requirements.commands) {
    if (!(await runtimeExecutable(command, runtime))) {
      missing.push({ type: "command", command });
    }
  }

  const range = requirements.harnessVersion;
  if (!range) {
    return missing;
  }

  if (!validRange(range)) {
    return [...missing, { type: "invalid-range", range }];
  }

  const installed = await toolVersion(harness, range, runtime);
  if (typeof installed !== "string") {
    return [...missing, installed];
  }

  return satisfies(installed, range)
    ? missing
    : [...missing, { type: "version", range, installed }];
}

/** The first requirement this machine misses, or null when it has them all. */
export async function runtimeRequirements(
  harness: Harness,
  requirements: HookRequirements,
  runtime: RuntimeContext,
): Promise<MissingRequirement | null> {
  const [first] = await missingRequirements(harness, requirements, runtime);

  return first ?? null;
}

/**
 * What is missing, as the end of a sentence about the Hook:
 * `lint-on-save` + ` needs the deno command, which isn't installed here or isn't on your PATH`.
 */
export function requirementMessage(
  harness: Harness,
  missing: MissingRequirement,
): string {
  const tool = adapters[harness].name;

  switch (missing.type) {
    case "command":
      return `needs the ${missing.command} command, which isn't installed here or isn't on your PATH`;
    case "invalid-range":
      return `declares a ${tool} version BarnDog can't read: ${missing.range}`;
    case "tool-missing":
      return `needs ${tool} ${missing.range}, but BarnDog can't find ${tool} to check its version`;
    case "version-unknown":
      return `needs ${tool} ${missing.range}, but BarnDog couldn't read ${tool}'s version`;
    case "version":
      return `needs ${tool} ${missing.range}; this machine has ${missing.installed}`;
  }
}

/** What the developer can do about it, in words. */
export function requirementFix(
  harness: Harness,
  missing: MissingRequirement,
): string {
  const tool = adapters[harness].name;

  switch (missing.type) {
    case "command":
      return `Install ${missing.command}`;
    case "invalid-range":
      return "Ask the Hook's author to fix requirements.harnessVersion in hook.yaml";
    case "tool-missing":
    case "version-unknown":
    case "version":
      return `Install or update ${tool}`;
  }
}

/**
 * Why BarnDog doesn't install a Hook in one tool. Only `missing-requirement`
 * is a problem: the others mean the Hook simply isn't written for that tool.
 */
export type HookSkip =
  | { type: "no-implementation" }
  | { type: "no-command-hooks" }
  | { type: "missing-requirement"; requirement: MissingRequirement };

/** A skip as one sentence fragment, such as `No implementation for this harness`. */
export function skipReason(harness: Harness, skip: HookSkip): string {
  switch (skip.type) {
    case "no-implementation":
      return "No implementation for this harness";
    case "no-command-hooks":
      return `${adapters[harness].name} has no command hooks`;
    case "missing-requirement":
      return requirementMessage(harness, skip.requirement);
  }
}
