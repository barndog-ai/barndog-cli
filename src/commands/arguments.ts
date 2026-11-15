import { type CommandContext } from "./context.js";
import { type AssetKind } from "../config/selection.js";
import { CliError } from "../errors.js";

export function requireArguments(context: CommandContext, usage: string) {
  if (!context.mode.interactive) {
    throw new CliError(
      "Name the asset to act on, or run this in a terminal to choose from a list.",
      usage,
    );
  }
}

/** What `add` copies from, as its usage shows it. */
export const addArguments: Record<AssetKind, string> = {
  skill: " <source>",
  mcp: "",
  hook: " <url>",
};
