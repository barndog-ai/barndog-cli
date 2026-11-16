/**
 * Command lines BarnDog registers in a coding tool's hook settings, written
 * for the shell that tool runs them in (`windowsShell` in its hook profile).
 * The tool runs them, so BarnDog only has to get the syntax right.
 */
import {
  bashShell,
  encodedPowerShell,
  isWindows,
  powershellCall,
  type Invocation,
} from "../../platform.js";
import type { RuntimeContext } from "../../runtime.js";
import { adapters } from "../../harnesses/registry.js";
import type { Harness } from "../../harnesses/types.js";
import { posixQuote, posixWord, powershellQuote } from "../../shared/shell.js";

/** One command line, written for each shell a tool may run it in. */
type ShellLine = { posix: string; powershell: string };

/** Git Bash reads `C:/x` as `C:\x`, and `/` needs no thought inside quotes. */
const bashPath = (path: string, platform: NodeJS.Platform) =>
  isWindows(platform) ? path.replaceAll("\\", "/") : path;

function lineFor(
  harness: Harness,
  line: ShellLine,
  platform: NodeJS.Platform,
): string {
  if (!isWindows(platform)) {
    return line.posix;
  }

  switch (adapters[harness].hooks.windowsShell) {
    case "bash":
      return line.posix;
    case "powershell":
      return line.powershell;
  }
}

/** Starts a program (BarnDog's own entry scripts) from the tool's hook shell. */
export function programLine(
  harness: Harness,
  args: readonly string[],
  platform: NodeJS.Platform,
): string {
  return lineFor(
    harness,
    {
      posix: args.map((arg) => posixWord(bashPath(arg, platform))).join(" "),
      powershell: powershellCall(args),
    },
    platform,
  );
}

/**
 * The Hook author's command with `BARNDOG_HOOK_ROOT` and the tool's own root
 * variables set to the installed folder, so a script written for the tool
 * finds its files and recognises where it runs.
 */
function hookLine(
  root: string,
  command: string,
  harness: Harness,
  platform: NodeJS.Platform,
): ShellLine {
  const variables = [
    "BARNDOG_HOOK_ROOT",
    ...adapters[harness].hooks.rootVariables,
  ];

  const posixRoot = posixQuote(bashPath(root, platform));

  return {
    posix: `export ${variables.map((name) => `${name}=${posixRoot}`).join(" ")}; ${command}`,
    powershell: `${variables.map((name) => `$env:${name}=${powershellQuote(root)}`).join("; ")}; ${command}`,
  };
}

export const hookCommand = (
  root: string,
  command: string,
  harness: Harness,
  platform: NodeJS.Platform,
) => lineFor(harness, hookLine(root, command, harness, platform), platform);

/** How `hooks test` runs a Hook: in the shell its tool would use. */
export async function hookInvocation(
  root: string,
  command: string,
  harness: Harness,
  runtime: RuntimeContext,
): Promise<Invocation> {
  const line = hookLine(root, command, harness, runtime.platform);
  if (
    isWindows(runtime.platform) &&
    adapters[harness].hooks.windowsShell !== "bash"
  ) {
    return encodedPowerShell(line.powershell);
  }

  const shell = await bashShell(runtime);

  return { command: shell.command, args: [...shell.args, line.posix] };
}
