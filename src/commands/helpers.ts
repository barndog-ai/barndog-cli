import { safe, json, renderValue } from "../ui/format.js";
import { renderMcp } from "../ui/mcp.js";
import { type CommandContext } from "./context.js";
import { pickInstalled, resolveOrigin } from "./origin.js";
import { type AssetKind } from "../config/selection.js";

/** What every command group prints with and how it finds the asset a command names. */
export function commandHelpers(context: CommandContext) {
  const write = (value: string) => context.write(safe(value));
  const print = (result: unknown) => {
    if (context.mode.json) {
      context.write(json(result));
    } else if (typeof result === "object" && result && "message" in result) {
      write(String(result.message));
    } else {
      for (const line of renderValue(result)) {
        context.write(line);
      }
    }
  };

  const printMcp = (result: unknown) => {
    for (const line of renderMcp(result)) {
      context.write(line);
    }
  };

  /** Adds the owning scope, asking only when several scopes share the name. */
  const locate = async <T extends { origin?: string }>(
    kind: AssetKind,
    name: string | undefined,
    options: T,
    usage: string,
  ) =>
    name
      ? {
          ...options,
          name,
          origin: await resolveOrigin(context, {
            kind,
            name,
            origin: options.origin,
            usage: usage.replace("<name>", name),
          }),
        }
      : { ...options, ...(await pickInstalled(context, kind, usage)) };

  return { write, print, printMcp, locate };
}
