import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { posix, win32 } from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import { promisify } from "node:util";

import type { RuntimeContext } from "./runtime.js";
import { CliError } from "./errors.js";
import { POSIX_MODE } from "./shared/constants.js";
import { ifExists, isInside } from "./shared/files.js";
import { PLAIN_WORD, posixQuote, powershellQuote } from "./shared/shell.js";
import { errorCode } from "./shared/values.js";

const execute = promisify(execFile);

/**
 * Environment variables the operating system defines, read through
 * `environmentValue()` (Windows names are case-insensitive).
 */
const OS_VARIABLES = {
  path: "PATH",
  /** Windows: extensions PATH lookup tries, such as `.EXE;.CMD`. */
  pathExtensions: "PATHEXT",
  /** Windows: `C:\Program Files` and its 32-bit twin. */
  programFiles: "ProgramFiles",
  programFilesX86: "ProgramFiles(x86)",
  /** Windows: `C:\Windows`, which holds WSL's `bash.exe` launcher. */
  systemRoot: "SystemRoot",
  /** Windows: `C:\Users\<you>\AppData\Local`, where per-user apps install. */
  localAppData: "LOCALAPPDATA",
  /** Linux: XDG Base Directory specification. */
  dataHome: "XDG_DATA_HOME",
  dataDirectories: "XDG_DATA_DIRS",
} as const;

/** cmd.exe's own PATHEXT when the variable is unset. */
const DEFAULT_PATH_EXTENSIONS = ".COM;.EXE;.BAT;.CMD";

/** XDG Base Directory specification default for `XDG_DATA_DIRS`. */
const DEFAULT_DATA_DIRECTORIES = "/usr/local/share:/usr/share";

/** Error codes meaning "not there" while probing a path that may not exist. */
const ABSENT = ["ENOENT", "ENOTDIR", "EACCES"];

/** A program and its argument vector, started without a shell. */
export type Invocation = { command: string; args: string[] };

export const isWindows = (platform: NodeJS.Platform) => platform === "win32";

export const pathsFor = (platform: NodeJS.Platform) =>
  isWindows(platform) ? win32 : posix;

export const directoryLinkType = (platform: NodeJS.Platform) =>
  isWindows(platform) ? "junction" : "dir";

/** Windows environment variable names are case insensitive. */
export function environmentValue(
  runtime: Pick<RuntimeContext, "env" | "platform">,
  name: string,
): string | undefined {
  const key = isWindows(runtime.platform)
    ? Object.keys(runtime.env).find(
        (key) => key.toLowerCase() === name.toLowerCase(),
      )
    : name;

  return key ? runtime.env[key] : undefined;
}

function executableNames(
  command: string,
  extensions: string[],
  windows: boolean,
) {
  if (windows && !win32.extname(command)) {
    return extensions.map((extension) => command + extension.toLowerCase());
  }

  return [command];
}

/** Searches only the supplied PATH; tests can exercise Windows PATHEXT on any host. */
export async function findExecutable(
  command: string,
  runtime: RuntimeContext,
): Promise<string | null> {
  const paths = pathsFor(runtime.platform);
  const windows = isWindows(runtime.platform);
  const extensions = windows
    ? (
        environmentValue(runtime, OS_VARIABLES.pathExtensions) ??
        DEFAULT_PATH_EXTENSIONS
      ).split(";")
    : [""];

  const names = executableNames(command, extensions, windows);
  const locations =
    command.includes("/") || command.includes("\\")
      ? [""]
      : (environmentValue(runtime, OS_VARIABLES.path) ?? "")
          .split(windows ? ";" : ":")
          .filter(Boolean);

  for (const directory of locations) {
    for (const name of names) {
      const candidate = paths.resolve(
        runtime.cwd,
        directory.replaceAll('"', ""),
        name,
      );

      try {
        if (!(await stat(candidate)).isFile()) {
          continue;
        }

        await access(candidate, windows ? constants.F_OK : constants.X_OK);

        return candidate;
      } catch (error) {
        if (!ABSENT.includes(errorCode(error) ?? "")) {
          throw error;
        }
      }
    }
  }

  return null;
}

/** Quotes for the shell people type fix hints into: PowerShell on Windows. */
const shellQuote = (value: string, platform: NodeJS.Platform) =>
  isWindows(platform) ? powershellQuote(value) : posixQuote(value);

/**
 * Fix hints name commands for the shell people type into: Bash or zsh on
 * macOS and Linux, PowerShell on Windows. Each step runs only when the one
 * before it succeeded; Windows PowerShell 5 has no `&&`, so there each later
 * step goes inside `if ($?) { … }`.
 */
export function fixSteps(steps: string[], platform: NodeJS.Platform): string {
  if (!isWindows(platform)) {
    return steps.join(" && ");
  }

  return steps.reduceRight(
    (rest, step) => (rest ? `${step}; if ($?) { ${rest} }` : step),
    "",
  );
}

export function removeCommand(path: string, platform: NodeJS.Platform) {
  return isWindows(platform)
    ? `Remove-Item -Recurse -Force ${shellQuote(path, platform)}`
    : `rm -rf ${shellQuote(path, platform)}`;
}

/** One word for the platform's shell, quoted only when it needs to be. */
export function shellWord(value: string, platform: NodeJS.Platform) {
  return PLAIN_WORD.test(value) ? value : shellQuote(value, platform);
}

/** Checks that the user's Git credentials can read `url`; clones nothing. */
export function gitAccessCommand(url: string, platform: NodeJS.Platform) {
  return `git ls-remote ${shellQuote(url, platform)}`;
}

export function unsetCommand(variable: string, platform: NodeJS.Platform) {
  return isWindows(platform)
    ? `Remove-Item Env:${variable}`
    : `unset ${variable}`;
}

/**
 * Windows PowerShell running `script`, passed encoded so no character in it
 * needs quoting as a program argument.
 */
export function encodedPowerShell(script: string): Invocation {
  return {
    command: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      // -EncodedCommand takes Base64 of UTF-16LE text.
      Buffer.from(
        "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; " +
          script,
        "utf16le",
      ).toString("base64"),
    ],
  };
}

/**
 * A program run from a PowerShell line, keeping its exit code. A program that
 * can't be found sets no `$LASTEXITCODE`, and `exit $null` would report
 * success, so that case exits 1.
 */
export const powershellCall = (args: readonly string[]) =>
  `& ${args.map(powershellQuote).join(" ")}; if ($null -eq $LASTEXITCODE) { exit 1 }; exit $LASTEXITCODE`;

/**
 * A program's stdout. Starts through cross-spawn, which also runs Windows
 * `.cmd` and `.bat` shims (such as npm-installed tools) with safely quoted
 * arguments. Fails when the program exits non-zero, runs past `timeoutMs` or
 * prints more than `maxBytes`.
 */
export function programOutput(
  command: string,
  args: readonly string[],
  runtime: RuntimeContext,
  limits: { timeoutMs: number; maxBytes: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(command, [...args], {
      env: { ...runtime.env },
      cwd: runtime.cwd,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });

    // Decoded once at the end, so a character split across chunks survives.
    const chunks: Buffer[] = [];
    let length = 0;
    const fail = (reason: string) => {
      child.kill();
      reject(new Error(`${command} ${reason}`));
    };

    const timer = setTimeout(() => fail("timed out"), limits.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > limits.maxBytes) {
        fail("printed too much");
      } else {
        chunks.push(chunk);
      }
    });

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString("utf8"));
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

/**
 * Bash for a tool that runs hook commands in it: `/bin/sh` on macOS and
 * Linux, Git for Windows' Bash on Windows (where Claude Code finds it too).
 */
export async function bashShell(runtime: RuntimeContext): Promise<Invocation> {
  if (!isWindows(runtime.platform)) {
    return { command: "/bin/sh", args: ["-c"] };
  }

  const paths = pathsFor(runtime.platform);
  for (const root of [
    environmentValue(runtime, OS_VARIABLES.programFiles),
    environmentValue(runtime, OS_VARIABLES.programFilesX86),
  ]) {
    // Git for Windows' default install folder.
    const candidate = root && paths.join(root, "Git", "bin", "bash.exe");
    if (candidate && (await ifExists(stat(candidate)))?.isFile()) {
      return { command: candidate, args: ["-c"] };
    }
  }

  // `C:\Windows\System32\bash.exe` starts WSL's Linux, not the Bash tools run
  // hooks in, so a Bash found there doesn't count.
  const bash = await findExecutable("bash", runtime);
  const system = environmentValue(runtime, OS_VARIABLES.systemRoot);
  if (
    bash &&
    !(system && isInside(system.toLowerCase(), bash.toLowerCase(), paths))
  ) {
    return { command: bash, args: ["-c"] };
  }

  throw new CliError(
    "This Hook runs in Bash, which isn't installed.",
    "Install Git for Windows from https://gitforwindows.org, then try again.",
  );
}

/** POSIX Hook runtime declarations also recognize the Bash supplied by Git for Windows. */
export async function runtimeExecutable(
  command: string,
  runtime: RuntimeContext,
): Promise<string | null> {
  const executable = await findExecutable(command, runtime);
  if (
    executable ||
    !isWindows(runtime.platform) ||
    !["sh", "bash"].includes(command)
  ) {
    return executable;
  }

  try {
    return (await bashShell(runtime)).command;
  } catch (error) {
    if (error instanceof CliError) {
      return null;
    }

    throw error;
  }
}

/** Kill the whole Hook/MCP process tree, including grandchildren on Windows. */
export function stopProcessTree(
  child: ChildProcess,
  runtime: RuntimeContext,
  signal: NodeJS.Signals = "SIGKILL",
) {
  if (!child.pid) {
    return;
  }

  try {
    if (isWindows(runtime.platform)) {
      const killer = spawn(
        "taskkill.exe",
        // /T ends the process's children too, /F forces it.
        ["/pid", String(child.pid), "/T", "/F"],
        {
          stdio: "ignore",
          windowsHide: true,
          env: { ...runtime.env },
          cwd: runtime.cwd,
        },
      );

      killer.on("error", () => child.kill(signal));
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    /* The child has already exited. */
  }
}

/**
 * The environment for a Windows PowerShell (5.1) that BarnDog runs itself.
 * PowerShell 7 puts its own module folders first in `PSModulePath`, and a
 * Windows PowerShell started from it inherits them, then fails to load
 * PowerShell 7's `Microsoft.PowerShell.Security` (`Get-Acl`). Without the
 * variable, Windows PowerShell builds its default module path. Windows
 * environment names ignore case.
 */
function windowsPowerShellEnvironment(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => name.toUpperCase() !== "PSMODULEPATH",
    ),
  );
}

/** Windows DACLs replace POSIX modes: only the current user receives access. */
export async function protectPrivate(path: string, runtime: RuntimeContext) {
  if (!isWindows(runtime.platform)) {
    return;
  }

  const script = `$ErrorActionPreference='Stop'; $path=${shellQuote(path, runtime.platform)}; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=Get-Acl -LiteralPath $path; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleSpecific($rule)}; $inherit=if((Get-Item -LiteralPath $path).PSIsContainer){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}; $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$inherit,'None','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $path -AclObject $acl`;
  const invocation = encodedPowerShell(script);
  await execute(invocation.command, invocation.args, {
    env: windowsPowerShellEnvironment(runtime.env),
    cwd: runtime.cwd,
    windowsHide: true,
  });
}

/**
 * Whether a file's POSIX mode keeps it private. On Windows the ACL that
 * `protectPrivate()` sets on every write does that, and checking it would start
 * PowerShell on every command, so any mode passes.
 */
export function privatePermissions(mode: number, platform: NodeJS.Platform) {
  return isWindows(platform) || !(mode & POSIX_MODE.groupAndOtherBits);
}

/**
 * A desktop app as each platform installs it: `name` is the `.app` bundle
 * name without `.app` and the Windows program `<name>.exe`.
 */
export type DesktopApp = {
  name: string;
  /** The Windows install folder when it isn't `name`. */
  windowsFolder?: string;
  /** The Linux `.desktop` entry's file name without `.desktop`, when it isn't `name` in lowercase. */
  linuxEntry?: string;
};

/**
 * Where a desktop app would be installed, as `[path to check, evidence to report]`:
 * a macOS bundle counts only when it has a `Contents/MacOS` folder.
 */
function applicationCandidates(
  app: DesktopApp,
  runtime: RuntimeContext,
  macRoots: readonly string[],
): [string, string][] {
  const path = pathsFor(runtime.platform);
  if (runtime.platform === "darwin") {
    return macRoots.map((root) => {
      const bundle = path.join(root, `${app.name}.app`);

      return [path.join(bundle, "Contents", "MacOS"), bundle];
    });
  }

  if (isWindows(runtime.platform)) {
    const local = environmentValue(runtime, OS_VARIABLES.localAppData);
    const programFiles = environmentValue(runtime, OS_VARIABLES.programFiles);
    const executable = `${app.name}.exe`;
    const folder = app.windowsFolder ?? app.name;
    const paths = [
      ...(local
        ? [
            path.join(local, "Programs", folder, executable),
            path.join(local, folder, executable),
          ]
        : []),
      ...(programFiles ? [path.join(programFiles, folder, executable)] : []),
    ];

    return paths.map((candidate) => [candidate, candidate]);
  }

  const dataHome =
    environmentValue(runtime, OS_VARIABLES.dataHome) ??
    path.join(runtime.home, ".local", "share");

  const dataDirectories =
    environmentValue(runtime, OS_VARIABLES.dataDirectories) ??
    DEFAULT_DATA_DIRECTORIES;

  return [dataHome, ...dataDirectories.split(":")].map((root) => {
    const entry = path.join(
      root,
      "applications",
      `${app.linuxEntry ?? app.name.toLowerCase()}.desktop`,
    );

    return [entry, entry];
  });
}

/**
 * The installed desktop app, or null. `macRoots` replaces `/Applications` and
 * `~/Applications`, so tests don't see apps installed on the machine.
 */
export async function installedApplication(
  app: DesktopApp,
  runtime: RuntimeContext,
  macRoots: readonly string[] = [
    "/Applications",
    pathsFor(runtime.platform).join(runtime.home, "Applications"),
  ],
): Promise<string | null> {
  for (const [probe, evidence] of applicationCandidates(
    app,
    runtime,
    macRoots,
  )) {
    try {
      await stat(probe);

      return evidence;
    } catch (error) {
      if (!ABSENT.includes(errorCode(error) ?? "")) {
        throw error;
      }
    }
  }

  return null;
}

/** The `#!` that starts a script the kernel can run directly. */
const SHEBANG = "#!";

/**
 * Whether a file is executable. Windows files have no executable bit, so
 * there the flag comes from `known` (what BarnDog last wrote at that path),
 * else from a `#!` first line, as Git for Windows guesses for a new script.
 */
export async function fileExecutable(
  path: string,
  mode: number,
  runtime: RuntimeContext,
  known?: boolean,
): Promise<boolean> {
  if (!isWindows(runtime.platform)) {
    return !!(mode & POSIX_MODE.executableBits);
  }

  return (
    known ??
    (await readFile(path)).subarray(0, SHEBANG.length).toString() === SHEBANG
  );
}

/**
 * DOS device names are reserved even with an extension: `CON`, `con.txt`,
 * `LPT1.log`, but not `console` or `com10`.
 *
 * @internal
 */
export const WINDOWS_DEVICE_NAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** A package path can be valid on macOS and Linux yet impossible to store on Windows. */
export function assertPackagePaths(
  entries: readonly { path: string }[],
  platform: NodeJS.Platform,
) {
  if (!isWindows(platform)) {
    return;
  }

  const names = new Set(entries.map((entry) => entry.path.toLowerCase()));
  if (names.size !== entries.length) {
    throw new CliError(
      "The package has paths that differ only in case, so it can't be stored on Windows.",
      "Ask its author to rename one of them.",
    );
  }

  for (const { path } of entries) {
    const parts = path.split("/");
    for (const part of parts) {
      if (invalidWindowsPart(part)) {
        throw new CliError(
          `The package file ${path} has a name Windows can't store.`,
          "Ask its author to rename it.",
        );
      }
    }

    for (let depth = 1; depth < parts.length; depth++) {
      if (names.has(parts.slice(0, depth).join("/").toLowerCase())) {
        throw new CliError(
          `The package file ${path} is inside a folder that differs only in case from a file, so it can't be stored on Windows.`,
          "Ask its author to rename one of them.",
        );
      }
    }
  }
}

function invalidWindowsPart(part: string) {
  return (
    !part ||
    part === "." ||
    part === ".." ||
    WINDOWS_DEVICE_NAME.test(part) ||
    [...'<>:"\\|?*'].some((char) => part.includes(char)) ||
    part.endsWith(".") ||
    part.endsWith(" ") ||
    [...part].some((char) => char.charCodeAt(0) < " ".charCodeAt(0))
  );
}

/** Resolve CLI input against the captured cwd; a drive-relative path must not consult Windows' hidden per-drive cwd. */
export function localPath(value: string, runtime: RuntimeContext) {
  const paths = pathsFor(runtime.platform);
  if (
    isWindows(runtime.platform) &&
    value[1] === ":" &&
    !paths.isAbsolute(value)
  ) {
    throw new CliError(
      `${value} is relative to the current folder of drive ${value.slice(0, 2)}, which BarnDog can't see.`,
      `Use an absolute path such as ${value.slice(0, 2)}\\${value.slice(2)}.`,
    );
  }

  return paths.resolve(runtime.cwd, value);
}
