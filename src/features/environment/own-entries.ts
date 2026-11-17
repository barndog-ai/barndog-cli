/**
 * What a sync registers for BarnDog itself, apart from the developer's assets:
 * the session-start commands that list shared knowledge and sync the workspace.
 */
import type { RuntimeContext } from "../../runtime.js";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Settings } from "../../config/settings.js";
import { CliError } from "../../errors.js";
import { adapters, nativeFile } from "../../harnesses/registry.js";
import type { Harness, HarnessAdapter } from "../../harnesses/types.js";
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

/** A built entry script a coding tool runs. */
const entryScript = (name: string) =>
  fileURLToPath(new URL(`../../entry/${name}.js`, import.meta.url));

/**
 * One session-start registration that runs `program` (an entry script and its
 * arguments, run by Node): a command hook in the tool's hook settings, or for
 * a tool without command hooks, a line of options in BarnDog's plugin module,
 * keyed by `kind`.
 */
function startupEntry(
  harness: Harness,
  registration: {
    id: string;
    kind: "knowledge" | "sync";
    program: string[];
  },
  runtime: RuntimeContext,
): NativeEntry {
  const { id, kind, program } = registration;
  const adapter: HarnessAdapter = adapters[harness];
  const file = nativeFile(harness, kind, runtime.home);
  const command = [process.execPath, ...program];

  if (!adapter.hooks) {
    return {
      id,
      kind,
      harness,
      file,
      key: kind,
      value: {
        entry: pathToFileURL(entryScript(adapter.plugin.entryScript)).href,
        command,
      },
    };
  }

  return {
    id,
    kind,
    harness,
    file,
    key: adapter.hooks.sessionStart,
    value: adapter.hooks.entry(
      programLine(adapter.id, command, runtime.platform),
    ),
  };
}

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
      entries.push(
        startupEntry(
          harness,
          {
            id: "barndog-knowledge-index",
            kind: "knowledge",
            program: [script, harness, home],
          },
          runtime,
        ),
      );
    }
  }

  if (settings.connection || settings.gitWorkspace || settings.localWorkspace) {
    const script = entryScript("workspace-startup");

    for (const harness of settings.harnesses) {
      entries.push(
        startupEntry(
          harness,
          {
            id: "barndog-workspace-sync",
            kind: "sync",
            program: [script, home],
          },
          runtime,
        ),
      );
    }
  }

  return entries;
}
