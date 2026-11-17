/**
 * BarnDog's plugin module for a coding tool without command hooks (OpenCode).
 * BarnDog owns the whole file: its text is rendered from the session-start
 * entries a sync plans, and a file that differs from what the previous sync
 * wrote was edited by hand.
 */
import { z } from "zod";

import { CliError } from "../../errors.js";
import { adapters } from "../../harnesses/registry.js";
import type { HarnessAdapter } from "../../harnesses/types.js";
import { removeCommand } from "../../platform.js";
import { defined } from "../../shared/lookup.js";
import type { NativeEntry } from "./configuration.js";

/** The value of a session-start entry kept in a plugin module (see `startupEntries()`). */
const pluginEntrySchema = z.object({
  /** BarnDog's plugin entry script, as a file URL. */
  entry: z.string(),
  command: z.array(z.string()),
});

/** Whether these entries live in a tool's plugin module rather than a settings file. */
export function inPluginModule(entries: readonly NativeEntry[]) {
  const sample = entries[0];

  return (
    sample !== undefined &&
    sample.kind !== "mcp" &&
    adapters[sample.harness].hooks === undefined
  );
}

/** The module's text for `entries`, or null when there are none and the file goes away. */
function render(entries: readonly NativeEntry[]): string | null {
  const sample = entries[0];
  if (!sample) {
    return null;
  }

  const adapter: HarnessAdapter = adapters[sample.harness];
  const plugin = defined(
    adapter.plugin,
    `${adapter.name} has no plugin module`,
  );

  const options = Object.fromEntries(
    [...entries]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((entry) => [
        entry.key,
        pluginEntrySchema.parse(entry.value).command,
      ]),
  );

  return plugin.module(pluginEntrySchema.parse(sample.value).entry, options);
}

/**
 * The plugin module's next text, after checking that `text` (what is on disk,
 * null when absent) is what BarnDog wrote for `before`. Null removes it.
 */
export function pluginModule(
  text: string | null,
  change: { before: readonly NativeEntry[]; after: readonly NativeEntry[] },
  platform: NodeJS.Platform,
): string | null {
  const { before, after } = change;
  const { file } = defined(
    after[0] ?? before[0],
    "pluginModule needs at least one entry to know which file it writes",
  );

  if (text !== render(before)) {
    throw new CliError(
      before.length
        ? `${file} was changed by hand, so BarnDog left it unchanged.`
        : `${file} already exists, and BarnDog didn't write it.`,
      before.length
        ? "Delete it, then sync again to write it afresh."
        : "Move it elsewhere if you need it, delete it, then sync again.",
      { command: removeCommand(file, platform) },
    );
  }

  return render(after);
}
