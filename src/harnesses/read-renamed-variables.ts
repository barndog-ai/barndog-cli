/**
 * Reads back a command `withRenamedVariables()` (`renamed-variables.ts`)
 * wrote, on either platform, so an entry BarnDog no longer owns (after
 * `barndog uninstall --keep-setup`) imports as the server it starts. Anything
 * else, a wrapper edited by hand included, reads as no wrapper: the result
 * must rebuild the exact same command.
 */
import { isDeepStrictEqual } from "node:util";

import { encodedPowerShell, type Invocation } from "../platform.js";
import { VARIABLE_NAME } from "../shared/patterns.js";
import {
  POSIX_SHELL,
  withRenamedVariables,
  type RenamedVariable,
} from "./renamed-variables.js";

/** The server a wrapper starts, and the variables it renames on the way. */
export type WrappedServer = { server: Invocation; renamed: RenamedVariable[] };

export function renamedVariablesOf(
  entry: Invocation,
): WrappedServer | undefined {
  const platform = entry.command === POSIX_SHELL ? "linux" : "win32";
  const wrapped =
    platform === "linux" ? posixWrapped(entry) : powershellWrapped(entry);

  return wrapped &&
    isDeepStrictEqual(
      withRenamedVariables(wrapped.server, wrapped.renamed, platform),
      entry,
    )
    ? wrapped
    : undefined;
}

/**
 * One renamed variable in the POSIX wrapper's script, as
 * `'GITHUB_PERSONAL_ACCESS_TOKEN='"$GITHUB_TOKEN"`: the name, then the source.
 *
 * @internal Exported for its table test in `src/tests/patterns.test.ts`.
 */
export const POSIX_RENAME = new RegExp(
  String.raw`'(${VARIABLE_NAME.source})='"\$(${VARIABLE_NAME.source})"`,
  "g",
);

function posixWrapped({ args }: Invocation): WrappedServer | undefined {
  const [flag, script, command, ...rest] = args;
  if (flag !== "-c" || script === undefined || command === undefined) {
    return undefined;
  }

  return {
    server: { command, args: rest },
    renamed: [...script.matchAll(POSIX_RENAME)].map(
      ([, name = "", from = ""]) => ({
        name,
        from,
      }),
    ),
  };
}

/**
 * Where the PowerShell wrapper reads one source variable, as
 * `$v0 = $env:GITHUB_TOKEN`, in the order of the renamed variables.
 *
 * @internal Exported for its table test in `src/tests/patterns.test.ts`.
 */
export const POWERSHELL_READ = new RegExp(
  String.raw`\$v\d+ = \$env:(${VARIABLE_NAME.source})`,
  "g",
);

/**
 * Where the PowerShell wrapper sets one renamed variable, as
 * `[Environment]::SetEnvironmentVariable('GITHUB_PERSONAL_ACCESS_TOKEN', $v0)`,
 * in the same order as its reads.
 *
 * @internal Exported for its table test in `src/tests/patterns.test.ts`.
 */
export const POWERSHELL_WRITE = new RegExp(
  String.raw`SetEnvironmentVariable\('(${VARIABLE_NAME.source})', \$v\d+\)`,
  "g",
);

/** What `powershellWrapper()` puts after the server's command and arguments. */
const POWERSHELL_EXIT =
  "; if ($null -eq $LASTEXITCODE) { exit 1 }; exit $LASTEXITCODE";

/** What `powershellWrapper()` puts before the server's command and arguments. */
const POWERSHELL_CALL = "; & ";

/** The script inside an `encodedPowerShell()` invocation, without its preamble. */
function encodedScript({ args }: Invocation): string | undefined {
  const decode = (value: string | undefined) =>
    Buffer.from(value ?? "", "base64").toString("utf16le");

  const preamble = decode(encodedPowerShell("").args.at(-1));
  const script = decode(args.at(-1));

  return script.startsWith(preamble)
    ? script.slice(preamble.length)
    : undefined;
}

function powershellWrapped(entry: Invocation): WrappedServer | undefined {
  const script = encodedScript(entry);
  // Only names come before the call, so the first call marker is the call's.
  const start = script?.indexOf(`${POWERSHELL_CALL}'`) ?? -1;
  if (!script || start < 0 || !script.endsWith(POWERSHELL_EXIT)) {
    return undefined;
  }

  const words = powershellWords(
    script.slice(start + POWERSHELL_CALL.length, -POWERSHELL_EXIT.length),
  );

  const [command, ...rest] = words ?? [];
  if (command === undefined) {
    return undefined;
  }

  const sources = [...script.matchAll(POWERSHELL_READ)].map(
    ([, from = ""]) => from,
  );

  const names = [...script.matchAll(POWERSHELL_WRITE)].map(
    ([, name = ""]) => name,
  );

  return {
    server: { command, args: rest.map(fromWindowsArgument) },
    renamed: names.map((name, index) => ({ name, from: sources[index] ?? "" })),
  };
}

/** PowerShell's single quotes, each doubled inside a quoted word (`powershellQuote()`). */
const SINGLE_QUOTES = "'\u2018\u2019\u201A\u201B";

/** The words of `'a' 'it''s'`, or undefined when the text isn't only quoted words. */
function powershellWords(text: string): string[] | undefined {
  const words: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (!SINGLE_QUOTES.includes(text.charAt(index))) {
      return undefined;
    }

    let word = "";
    index += 1;
    while (index < text.length) {
      const character = text.charAt(index);
      if (!SINGLE_QUOTES.includes(character)) {
        word += character;
        index += 1;
        continue;
      }

      if (text.charAt(index + 1) !== character) {
        break;
      }

      word += character;
      index += 2;
    }

    words.push(word);
    index += 1;
    if (index < text.length && text.charAt(index) !== " ") {
      return undefined;
    }

    index += 1;
  }

  return words;
}

/** The argument `windowsArgument()` was given, read back from what it wrote. */
function fromWindowsArgument(written: string): string {
  if (written === '""') {
    return "";
  }

  let value = "";
  let backslashes = 0;
  for (const character of written) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }

    value +=
      character === '"'
        ? `${"\\".repeat((backslashes - 1) / 2)}"`
        : `${"\\".repeat(backslashes)}${character}`;

    backslashes = 0;
  }

  const quoted = [...written].some((character) => character.trim() === "");

  return value + "\\".repeat(quoted ? backslashes / 2 : backslashes);
}
