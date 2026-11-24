#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CommanderError, InvalidArgumentError } from "commander";
import {
  assertCommandAvailable,
  currentSetupMode,
} from "./commands/availability.js";
import { captureRuntime, createProgram } from "./program.js";
import { renderError, renderJsonError } from "./ui/output.js";
import { json } from "./ui/format.js";
import { CliError, NothingToDoError, promptCancelled } from "./errors.js";
import { updateCheck } from "./features/update-check/index.js";
import { renderUpdateNotice } from "./ui/update.js";
import { cliVersion } from "./version.js";

// Parsing errors happen before any action runs, so read the flag directly.
const words = process.argv.slice(2);
const end = words.indexOf("--");
const asJson = (end < 0 ? words : words.slice(0, end)).includes("--json");

const runtime = captureRuntime();

try {
  await createProgram({
    runtime,
    guard: (path, options) => assertCommandAvailable(path, options, runtime),
    setupMode: await currentSetupMode(runtime),
    ...(asJson ? { writeError: () => undefined } : {}),
  }).parseAsync(process.argv);
} catch (error) {
  if (
    error instanceof CommanderError &&
    !(error instanceof InvalidArgumentError)
  ) {
    // Commander already printed help or the parsing error, unless it was silenced for --json.
    process.exitCode = error.exitCode;
    if (asJson && error.exitCode) {
      console.error(
        renderJsonError(
          new CliError(
            error.code === "commander.help"
              ? "Choose a subcommand. Add --help to see them."
              : error.message.replace(/^error: /, ""),
          ),
        ),
      );
    }
  } else if (promptCancelled(error)) {
    const message = "Cancelled. Nothing was changed.";
    console.log(asJson ? json({ message }) : message);
    process.exitCode = 130;
  } else if (error instanceof NothingToDoError) {
    console.log(asJson ? json({ message: error.message }) : error.message);
  } else {
    console.error(asJson ? renderJsonError(error) : renderError(error));
    process.exitCode = 1;
  }
}

// After the command, on stderr, so it never changes what a script reads; and
// it can never fail the command.
if (!asJson && process.stderr.isTTY) {
  try {
    const check = await updateCheck(cliVersion, runtime);
    if (check?.update) {
      console.error(renderUpdateNotice(check.update).join("\n"));
    }

    if (check?.due) {
      spawn(
        process.execPath,
        [
          fileURLToPath(new URL("entry/update-check.js", import.meta.url)),
          runtime.home,
        ],
        { detached: true, windowsHide: true, stdio: "ignore" },
      )
        .on("error", () => {})
        .unref();
    }
  } catch {
    // The next command checks again.
  }
}
