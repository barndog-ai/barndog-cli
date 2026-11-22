/**
 * Starting a stdio MCP server with some variables taken from other names
 * (`GITHUB_PERSONAL_ACCESS_TOKEN` from `GITHUB_TOKEN`), for a tool that can
 * only pass a variable on under its own name. The tool starts the system
 * shell, which sets each renamed variable and then replaces itself with the
 * server, so the entry needs nothing of BarnDog's and keeps working after
 * BarnDog is uninstalled.
 *
 * The server's command and arguments never become script text on POSIX: they
 * reach the shell as `$0` and `$@` and are passed on exactly as written. A
 * variable name is always `[A-Za-z_][A-Za-z0-9_]*` (the contract's `envName`),
 * so names are safe inside the script. Like any tool's own `env`, the mapping
 * is set before the server's command runs, so a command that sets the same
 * variable itself wins.
 */
import { encodedPowerShell, isWindows, type Invocation } from "../platform.js";
import { posixQuote, powershellQuote } from "../shared/shell.js";

/** A variable the server reads (`name`) and the local variable its value comes from. */
export type RenamedVariable = { name: string; from: string };

/** The POSIX shell, at the path POSIX systems (NixOS and Guix included) keep it. */
const POSIX_SHELL = "/bin/sh";

/**
 * `env`, which sets every variable from values the shell expanded before it
 * ran, so a swap (`A` from `B`, `B` from `A`) works.
 */
const POSIX_ENV = "/usr/bin/env";

export function withRenamedVariables(
  server: Invocation,
  renamed: readonly RenamedVariable[],
  platform: NodeJS.Platform,
): Invocation {
  return isWindows(platform)
    ? powershellWrapper(server, renamed)
    : posixWrapper(server, renamed);
}

/** Each local variable once, in the order the definition names them. */
const sources = (renamed: readonly RenamedVariable[]) => [
  ...new Set(renamed.map((variable) => variable.from)),
];

/**
 * `/bin/sh -c '<script>' <command> <args…>`. `${X:?…}` stops with a message
 * when `X` is unset or empty, as the tool's own reference would leave the
 * server without a value; the tool shows the message as the server's error.
 */
function posixWrapper(
  server: Invocation,
  renamed: readonly RenamedVariable[],
): Invocation {
  const checks = sources(renamed).map(
    (from) => `: "\${${from}:?${from} is not set}"; `,
  );

  const assignments = renamed.map(
    ({ name, from }) => `${posixQuote(`${name}=`)}"$${from}"`,
  );

  const script = `${checks.join("")}exec ${POSIX_ENV} ${assignments.join(" ")} "$0" "$@"`;

  return {
    command: POSIX_SHELL,
    args: ["-c", script, server.command, ...server.args],
  };
}

/**
 * Windows PowerShell running the same steps. Its arguments can't be passed
 * apart from the script, so the command and arguments are quoted into it, and
 * the script is encoded so the tool's own argument quoting can't change it.
 * Values are read before any is set, so a swap works here too.
 */
function powershellWrapper(
  server: Invocation,
  renamed: readonly RenamedVariable[],
): Invocation {
  const checks = sources(renamed).map(
    (from) =>
      `if (-not $env:${from}) { [Console]::Error.WriteLine(${powershellQuote(`${from} is not set`)}); exit 1 }`,
  );

  const reads = renamed.map(({ from }, index) => `$v${index} = $env:${from}`);
  const writes = renamed.map(
    ({ name }, index) =>
      `[Environment]::SetEnvironmentVariable(${powershellQuote(name)}, $v${index})`,
  );

  const call = [
    powershellQuote(server.command),
    ...server.args.map((arg) => powershellQuote(windowsArgument(arg))),
  ].join(" ");

  const script = [
    ...checks,
    ...reads,
    ...writes,
    `& ${call}; if ($null -eq $LASTEXITCODE) { exit 1 }; exit $LASTEXITCODE`,
  ].join("; ");

  return encodedPowerShell(script);
}

/**
 * An argument written so the program receives it unchanged from Windows
 * PowerShell 5.1, which builds the command line itself: it puts quotes around
 * an argument with whitespace outside quotes, drops an empty one, and passes
 * every other character as is. The program then splits the line by the
 * Microsoft C runtime's rules, where `\"` is a literal quote and backslashes
 * count only before a quote. So `""` stands for an empty argument, each quote
 * gets a backslash (and the backslashes before it double), and trailing
 * backslashes double when PowerShell will close the argument with a quote.
 */
function windowsArgument(value: string): string {
  if (value === "") {
    return '""';
  }

  let written = "";
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }

    written +=
      character === '"'
        ? `${"\\".repeat(backslashes * 2 + 1)}"`
        : `${"\\".repeat(backslashes)}${character}`;

    backslashes = 0;
  }

  const quoted = [...value].some((character) => character.trim() === "");

  return written + "\\".repeat(quoted ? backslashes * 2 : backslashes);
}
