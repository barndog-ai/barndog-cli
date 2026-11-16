/**
 * What a sync registers for BarnDog itself, apart from the developer's assets:
 * the session-start commands that list shared knowledge and sync the workspace.
 */
import type { RuntimeContext } from "../../runtime.js";
import { fileURLToPath } from "node:url";

import type { Settings } from "../../config/settings.js";
import { CliError } from "../../errors.js";
import { adapters, nativeFile } from "../../harnesses/registry.js";
import type { Harness } from "../../harnesses/types.js";
import { environmentValue, pathsFor, unsetCommand } from "../../platform.js";
import { programLine } from "../native/hook-shell.js";
import type { NativeEntry } from "../native/configuration.js";

/**
 * Refuses to sync while a selected coding tool is told to keep its settings
 * somewhere other than the folder BarnDog writes to.
 */
export function assertSupportedConfigHomes(
  harnesses: readonly Harness[],
  runtime: RuntimeContext,
) {
  const { home } = runtime;

  for (const harness of harnesses) {
    const { configHome } = adapters[harness];
    const custom = configHome && environmentValue(runtime, configHome.variable);
    if (!configHome || !custom) {
      continue;
    }

    const paths = pathsFor(runtime.platform);
    const isDefault =
      paths.relative(
        paths.resolve(runtime.cwd, custom),
        paths.join(home, configHome.directory),
      ) === "";

    if (!isDefault || !configHome.defaultIsSupported) {
      throw new CliError(
        `BarnDog can't install into a custom ${configHome.variable} yet; it uses ~/${configHome.directory}.`,
        `Stop setting ${configHome.variable}, including in your shell profile, then sync again.`,
        { command: unsetCommand(configHome.variable, runtime.platform) },
      );
    }
  }
}

/** The built entry script a coding tool runs at session start. */
const entryScript = (name: string) =>
  fileURLToPath(new URL(`../../entry/${name}.js`, import.meta.url));

/**
 * BarnDog's own session-start registrations for every selected coding tool.
 * The knowledge index needs a workspace to read from (`knowledge`) and the
 * setting left on; the workspace sync is registered for every workspace type.
 */
export function startupEntries(
  settings: Settings,
  runtime: RuntimeContext,
  available: { knowledge: boolean },
): NativeEntry[] {
  const { home } = runtime;

  const entries: NativeEntry[] = [];

  if (available.knowledge && settings.knowledge !== false) {
    const script = entryScript("knowledge-startup");

    for (const harness of settings.harnesses) {
      const command = programLine(
        harness,
        [process.execPath, script, harness, home],
        runtime.platform,
      );

      entries.push({
        id: "barndog-knowledge-index",
        kind: "knowledge",
        harness,
        file: nativeFile(harness, "knowledge", home),
        key: adapters[harness].hooks.sessionStart,
        value: adapters[harness].hooks.entry(command),
      });
    }
  }

  if (settings.connection || settings.gitWorkspace || settings.localWorkspace) {
    const script = entryScript("workspace-startup");

    for (const harness of settings.harnesses) {
      const command = programLine(
        harness,
        [process.execPath, script, home],
        runtime.platform,
      );

      entries.push({
        id: "barndog-workspace-sync",
        kind: "sync",
        harness,
        file: nativeFile(harness, "sync", home),
        key: adapters[harness].hooks.sessionStart,
        value: adapters[harness].hooks.entry(command),
      });
    }
  }

  return entries;
}
