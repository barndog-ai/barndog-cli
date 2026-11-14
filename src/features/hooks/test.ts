import { MILLISECONDS_PER_SECOND } from "../../shared/constants.js";

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { parse } from "yaml";
import { hookManifestSchema, hookSchema } from "@barndog-ai/api-contract";
import type { Harness } from "../../harnesses/types.js";
import { selectAsset } from "../environment/remote.js";
import { cachedPackage } from "../environment/packages.js";
import { hookCommand, runtimeRequirements } from "../native/adapters.js";
import { readSettings } from "../../config/settings.js";
import { repoForOrigin, selectRepoAsset } from "../git-workspace/assets.js";

/** CLI hook test policy caps each input/output stream at one MiB. */
const HOOK_IO_LIMIT_BYTES = 1048576;

/** CLI hook test policy defaults to ten seconds. */
const DEFAULT_HOOK_TIMEOUT_SECONDS = 10;

/** CLI hook test policy caps execution at ten minutes. */
const MAX_HOOK_TIMEOUT_SECONDS = 600;

async function hookPackage(name: string, origin: string, home: string) {
  const settings = await readSettings(home);
  const repo = settings && repoForOrigin(settings, home, origin);
  if (repo) {
    const asset = selectRepoAsset(await repo.model(), "hook", name, origin);

    return repo.skillOrHookPackage("hook", asset);
  }

  const selected = await selectAsset("hook", name, origin, home);
  const asset = hookSchema.parse(selected.asset);

  return cachedPackage("hook", asset, selected.connection, home);
}

export type HookTestOptions = {
  harness: Harness;
  /** The native JSON input, as text. */
  input: string;
  event?: string;
  /** Which command, when the event has several. */
  handler?: number;
  timeout?: number;
};

/** How a Hook's script ran on the supplied input. */
export type HookTestResult = {
  harness: Harness;
  event: string;
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

/**
 * Executes the selected Hook command in a POSIX shell with supplied native
 * input, enforcing runtime and output limits.
 */
export async function testHook(
  name: string,
  origin: string,
  options: HookTestOptions,
  {
    home = homedir(),
    cwd = process.cwd(),
  }: { home?: string; cwd?: string } = {},
): Promise<HookTestResult> {
  if (process.platform === "win32") {
    throw new Error("Command Hook testing currently requires a POSIX shell");
  }

  const root = await hookPackage(name, origin, home);
  const manifest = hookManifestSchema.parse(
    parse(await readFile(join(root, "hook.yaml"), "utf8")),
  );

  const implementation = manifest.implementations[options.harness];
  if (!implementation) {
    throw new Error(`No ${options.harness} implementation`);
  }

  const unmet = await runtimeRequirements(
    options.harness,
    implementation.requirements,
  );

  if (unmet) {
    throw new Error(unmet);
  }

  const event =
    options.event ??
    (Object.keys(implementation.events).length === 1
      ? Object.keys(implementation.events)[0]
      : undefined);

  if (!event || !implementation.events[event]) {
    throw new Error(
      `Choose --event from: ${Object.keys(implementation.events).join(", ")}`,
    );
  }

  const handlers = implementation.events[event].flatMap((h) =>
    "hooks" in h ? h.hooks : [h],
  );

  if (handlers.length > 1 && options.handler === undefined) {
    throw new Error("Choose --handler <number> to explicitly select a command");
  }

  const handler = handlers[(options.handler ?? 1) - 1];
  if (!handler) {
    throw new Error("Unknown Hook handler");
  }

  const input = await readFile(options.input);
  if (input.length > HOOK_IO_LIMIT_BYTES) {
    throw new Error("Hook input exceeds 1 MiB");
  }

  JSON.parse(input.toString("utf8"));
  const timeout =
    options.timeout ?? handler.timeout ?? DEFAULT_HOOK_TIMEOUT_SECONDS;

  if (
    !Number.isFinite(timeout) ||
    timeout <= 0 ||
    timeout > MAX_HOOK_TIMEOUT_SECONDS
  ) {
    throw new Error("Hook test timeout must be between 0 and 600 seconds");
  }

  const child = spawn(
    "/bin/sh",
    ["-c", hookCommand(root, handler.command, options.harness)],
    {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    },
  );

  let stdout = "";
  let stderr = "";
  let length = 0;
  let timedOut = false;

  const stop = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* exited */
      }
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeout * MILLISECONDS_PER_SECOND);

  for (const [stream, append] of [
    [
      child.stdout,
      (text: string) => {
        stdout += text;
      },
    ],
    [
      child.stderr,
      (text: string) => {
        stderr += text;
      },
    ],
  ] as const) {
    stream.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > HOOK_IO_LIMIT_BYTES) {
        stop();
      } else {
        append(chunk.toString());
      }
    });
  }

  child.stdin.on("error", () => undefined);
  child.stdin.end(input);
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });

    if (length > HOOK_IO_LIMIT_BYTES) {
      throw new Error("Hook test output exceeds 1 MiB");
    }

    return {
      harness: options.harness,
      event,
      exitCode,
      timedOut,
      stdout,
      stderr,
    };
  } finally {
    clearTimeout(timer);
    stop();
  }
}
