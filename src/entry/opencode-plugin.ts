/**
 * BarnDog's OpenCode plugin. OpenCode has no command hooks, so the module sync
 * writes to `~/.config/opencode/plugins/barndog.js` imports `barndog` from
 * here and hands it the command lines a session-start hook would run in other
 * tools. OpenCode runs plugins in its own process, so this file only starts
 * BarnDog's other entry scripts and never imports the CLI.
 */
import { execFile } from "node:child_process";

/** Each option is a command line, the program first. */
type PluginOptions = { knowledge?: string[]; sync?: string[] };

/** The parts of OpenCode's plugin hooks this plugin uses (`@opencode-ai/plugin` `Hooks`). */
type OpenCodeHooks = {
  event: (input: { event: { type: string } }) => Promise<void>;
  "experimental.chat.system.transform": (
    input: unknown,
    output: { system: string[] },
  ) => Promise<void>;
};

/** OpenCode's event for a new session, the counterpart of other tools' SessionStart. */
const SESSION_CREATED = "session.created";

/** knowledge-startup gives up after five seconds; this covers starting Node too. */
const COMMAND_TIMEOUT_MS = 10_000;
/** The index lists names and descriptions only; anything longer is broken. */
const OUTPUT_LIMIT_BYTES = 1_048_576;

/** A command's trimmed stdout; empty when it fails, so a session never does. */
function output([program, ...args]: string[]): Promise<string> {
  return new Promise((resolve) => {
    if (!program) {
      resolve("");

      return;
    }

    execFile(
      program,
      args,
      {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: OUTPUT_LIMIT_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        resolve(error ? "" : stdout.trim());
      },
    );
  });
}

/**
 * At each new session, starts the background workspace sync and reads the
 * knowledge index afresh; every request of that session gets the index added
 * to its system prompt.
 */
export function barndog(options: PluginOptions) {
  // OpenCode awaits what a plugin returns, so a plain object will do.
  return (): OpenCodeHooks => {
    let index: Promise<string> | undefined;

    return {
      event: async ({ event }) => {
        if (event.type !== SESSION_CREATED) {
          return;
        }

        index = undefined;

        if (options.sync) {
          await output(options.sync);
        }
      },
      "experimental.chat.system.transform": async (_input, result) => {
        if (!options.knowledge) {
          return;
        }

        index ??= output(options.knowledge);
        const text = await index;
        if (text) {
          result.system.push(text);
        }
      },
    };
  };
}
