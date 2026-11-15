/** The questions the add commands ask in a terminal; tests supply their own answers. */
import checkbox from "@inquirer/checkbox";
import confirm from "@inquirer/confirm";
import input from "@inquirer/input";
import select from "@inquirer/select";
import { createInterface } from "node:readline";
import { dim } from "./format.js";
import { checkboxTheme, promptTheme } from "./theme.js";

export type AddPrompts = {
  chooseMany: (
    message: string,
    choices: {
      name: string;
      value: string;
      short?: string;
      description?: string;
      checked?: boolean;
    }[],
  ) => Promise<string[]>;
  chooseOne: (
    message: string,
    choices: { name: string; value: string; description?: string }[],
    fallback?: string,
  ) => Promise<string>;
  text: (message: string, fallback?: string) => Promise<string>;
  yes: (message: string, fallback?: boolean) => Promise<boolean>;
  paste: () => Promise<string>;
};

/** Reads pasted lines until they form complete JSON, so nobody has to press Ctrl+D. */
function pasteJson(write: (line: string) => void) {
  write(dim("Paste the JSON. It's read as soon as it's complete."));

  return new Promise<string>((resolve) => {
    const lines: string[] = [];
    const reader = createInterface({ input: process.stdin });
    reader.on("line", (line) => {
      lines.push(line);
      try {
        JSON.parse(lines.join("\n"));
        reader.close();
      } catch {
        // Not complete yet.
      }
    });

    reader.on("close", () => resolve(lines.join("\n")));
  });
}

export const terminalPrompts = (write: (line: string) => void): AddPrompts => ({
  chooseMany: (message, choices) =>
    checkbox({
      message,
      choices,
      pageSize: 12,
      loop: false,
      theme: checkboxTheme,
    }),
  chooseOne: (message, choices, fallback) =>
    select({
      message,
      choices,
      default: fallback,
      pageSize: 12,
      loop: false,
      theme: promptTheme,
    }),
  text: (message, fallback) =>
    input({ message, default: fallback, theme: promptTheme }),
  yes: (message, fallback = true) =>
    confirm({ message, default: fallback, theme: promptTheme }),
  paste: () => pasteJson(write),
});
