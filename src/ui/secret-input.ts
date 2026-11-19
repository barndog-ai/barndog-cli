/** Reads an MCP variable's value without showing it or putting it in shell history. */
import input from "@inquirer/input";
import { promptTheme } from "./theme.js";

/** Asks in the terminal, echoing one `*` per character. */
export function askSecret(variable: string): Promise<string> {
  return input({
    message: `Value for ${variable}`,
    transformer: (value) => "*".repeat(value.length),
    theme: promptTheme,
  });
}

/** Everything piped in, without the final line break a file or `echo` adds. */
export async function readStdin(
  stream: AsyncIterable<Buffer | string> = process.stdin,
): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    text += chunk.toString();
  }

  return text.replace(/\r?\n$/, "");
}
