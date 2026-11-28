import { isWindows, localPath, stopProcessTree } from "../../platform.js";
import type { RuntimeContext } from "../../runtime.js";
import { MILLISECONDS_PER_SECOND } from "../../shared/constants.js";

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { parse } from "yaml";
import { hookManifestSchema, hookSchema } from "@barndog-ai/api-contract";
import type { HookHarness } from "../../harnesses/types.js";
import { selectAsset } from "../server/catalog.js";
import { cachedPackage } from "../workspace/packages.js";
import {
  requirementFix,
  requirementMessage,
  runtimeRequirements,
} from "../native/requirements.js";
import { hookInvocation } from "../native/hook-shell.js";
import { readSettings } from "../../config/settings.js";
import { repoForOrigin, selectRepoAsset } from "../workspace/assets.js";
import { CliError } from "../../errors.js";
import { inputFile } from "../../shared/files.js";

/** CLI hook test policy caps each input/output stream at one MiB. */
const HOOK_IO_LIMIT_BYTES = 1048576;

/** CLI hook test policy defaults to ten seconds. */
const DEFAULT_HOOK_TIMEOUT_SECONDS = 10;

/** CLI hook test policy caps execution at ten minutes. */
const MAX_HOOK_TIMEOUT_SECONDS = 600;

async function hookPackage(
  name: string,
  origin: string,
  runtime: RuntimeContext,
) {
  const { home } = runtime;

  const settings = await readSettings(home);
  const repo = settings && repoForOrigin(settings, runtime, origin);
  if (repo) {
    const asset = selectRepoAsset(await repo.model(), "hook", name, origin);

    return repo.packageFolder("hook", asset);
  }

  const selected = await selectAsset("hook", name, origin, runtime);
  const asset = hookSchema.parse(selected.asset);

  return cachedPackage("hook", asset, selected.connection, runtime);
}

export type HookTestOptions = {
  harness: HookHarness;
  /** The native JSON input, as text. */
  input: string;
  event?: string;
  /** Which command, when the event has several. */
  handler?: number;
  timeout?: number;
};

/** How a Hook's script ran on the supplied input. */
export type HookTestResult = {
  harness: HookHarness;
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
  runtime: RuntimeContext,
): Promise<HookTestResult> {
  const { cwd } = runtime;

  const root = await hookPackage(name, origin, runtime);
  const manifest = hookManifestSchema.parse(
    parse(await readFile(join(root, "hook.yaml"), "utf8")),
  );

  const implementation = manifest.implementations[options.harness];
  if (!implementation) {
    throw new CliError(
      `${name} has no ${options.harness} implementation.`,
      `barndog hooks test ${name} --harness <claude|codex|cursor>`,
    );
  }

  const unmet = await runtimeRequirements(
    options.harness,
    implementation.requirements,
    runtime,
  );

  if (unmet) {
    throw new CliError(
      `${name} ${requirementMessage(options.harness, unmet)}.`,
      requirementFix(options.harness, unmet),
    );
  }

  const event =
    options.event ??
    (Object.keys(implementation.events).length === 1
      ? Object.keys(implementation.events)[0]
      : undefined);

  if (!event || !implementation.events[event]) {
    throw new CliError(
      `Choose an event with --event: ${Object.keys(implementation.events).join(", ")}.`,
    );
  }

  const handlers = implementation.events[event].flatMap((h) =>
    "hooks" in h ? h.hooks : [h],
  );

  if (handlers.length > 1 && options.handler === undefined) {
    throw new CliError(
      "This event runs several commands. Choose one with --handler <number>.",
    );
  }

  const handler = handlers[(options.handler ?? 1) - 1];
  if (!handler) {
    throw new CliError(
      `This event has no command ${options.handler}. Choose 1 to ${handlers.length}.`,
    );
  }

  const inputPath = localPath(options.input, runtime);
  const input = await inputFile(inputPath);
  if (input.length > HOOK_IO_LIMIT_BYTES) {
    throw new CliError("The --input file is over 1 MiB.");
  }

  try {
    JSON.parse(input.toString("utf8"));
  } catch (error) {
    throw new CliError(
      `${inputPath} isn't valid JSON. --input takes the JSON event the tool would send the Hook.`,
      undefined,
      { cause: error },
    );
  }

  const timeout =
    options.timeout ?? handler.timeout ?? DEFAULT_HOOK_TIMEOUT_SECONDS;

  if (
    !Number.isFinite(timeout) ||
    timeout <= 0 ||
    timeout > MAX_HOOK_TIMEOUT_SECONDS
  ) {
    throw new CliError(
      "--timeout must be more than 0 and at most 600 seconds.",
    );
  }

  const shell = await hookInvocation(
    root,
    handler.command,
    options.harness,
    runtime,
  );

  const child = spawn(shell.command, shell.args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...runtime.env },
    detached: !isWindows(runtime.platform),
    windowsHide: true,
  });

  let timedOut = false;
  let overLimit = false;

  const stop = () => stopProcessTree(child, runtime);

  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeout * MILLISECONDS_PER_SECOND);

  // Bytes are kept and decoded once at the end, so a character split across
  // chunks survives; each stream has its own limit.
  const collect = (stream: NodeJS.ReadableStream) => {
    const chunks: Buffer[] = [];
    let length = 0;
    stream.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > HOOK_IO_LIMIT_BYTES) {
        overLimit = true;
        stop();
      } else {
        chunks.push(chunk);
      }
    });

    return () => Buffer.concat(chunks).toString("utf8");
  };

  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);

  child.stdin.on("error", () => undefined);
  child.stdin.end(input);
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });

    if (overLimit) {
      throw new CliError(
        "The Hook printed more than 1 MiB to stdout or stderr.",
      );
    }

    return {
      harness: options.harness,
      event,
      exitCode,
      timedOut,
      stdout: stdout(),
      stderr: stderr(),
    };
  } finally {
    clearTimeout(timer);
    stop();
  }
}
