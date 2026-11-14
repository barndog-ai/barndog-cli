#!/usr/bin/env node
import { CommanderError, InvalidArgumentError } from "commander";
import {
  assertCommandAvailable,
  currentSetupMode,
} from "./commands/availability.js";
import { createProgram } from "./program.js";
import { renderError, renderJsonError } from "./ui/output.js";
import { json } from "./ui/format.js";
import { CliError, NothingToDoError } from "./errors.js";

// Parsing errors happen before any action runs, so read the flag directly.
const words = process.argv.slice(2);
const end = words.indexOf("--");
const asJson = (end < 0 ? words : words.slice(0, end)).includes("--json");

try {
  await createProgram({
    guard: assertCommandAvailable,
    setupMode: await currentSetupMode(),
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
  } else if (error instanceof Error && error.name === "ExitPromptError") {
    console.log("Cancelled. Nothing was changed.");
    process.exitCode = 130;
  } else if (error instanceof NothingToDoError) {
    console.log(asJson ? json({ message: error.message }) : error.message);
  } else {
    console.error(asJson ? renderJsonError(error) : renderError(error));
    process.exitCode = 1;
  }
}
