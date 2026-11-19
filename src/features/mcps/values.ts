/**
 * `barndog mcp env`: the MCP variable values BarnDog keeps on this machine.
 * Each change syncs at once, so the coding tools' settings hold the new value,
 * or a reference again once the value is forgotten.
 */
import type { RuntimeContext } from "../../runtime.js";
import { readState } from "../../config/state.js";
import { CliError } from "../../errors.js";
import type { SyncEvent } from "../environment/events.js";
import { synchronize } from "../environment/sync.js";
import { recordedVariables } from "../native/secret-values.js";
import { readSecrets, updateSecrets } from "../secrets/index.js";

/** What changing a kept value did: the file it's kept in, and the sync that followed. */
export type KeptValueChange = { file: string; events: SyncEvent[] };

/** A kept variable and where sync wrote its value; never the value itself. */
export type KeptVariable = {
  variable: string;
  writtenTo: { file: string; server: string }[];
};

/** Keeps `value` for `variable` and writes it into the coding tools. */
export async function keepMcpValue(
  variable: string,
  value: string,
  runtime: RuntimeContext,
): Promise<KeptValueChange> {
  if (!value) {
    throw new CliError(
      `The value for ${variable} is empty, so nothing was kept.`,
      `barndog mcp env set ${variable}`,
    );
  }

  const file = await updateSecrets({ [variable]: value }, runtime);

  return { file, events: await synchronize(undefined, runtime) };
}

/** Forgets a kept value; the tools refer to the environment variable again. */
export async function forgetMcpValue(
  variable: string,
  runtime: RuntimeContext,
): Promise<KeptValueChange> {
  if ((await readSecrets(runtime))[variable] === undefined) {
    throw new CliError(
      `BarnDog doesn't keep a value for ${variable}.`,
      "barndog mcp env list",
    );
  }

  const file = await updateSecrets({ [variable]: null }, runtime);

  return { file, events: await synchronize(undefined, runtime) };
}

/** The kept variables, with the settings files sync wrote each into. */
export async function listKeptValues(
  runtime: RuntimeContext,
): Promise<KeptVariable[]> {
  const names = Object.keys(await readSecrets(runtime)).sort();
  const { native } = await readState(runtime.home);

  return names.map((variable) => ({
    variable,
    writtenTo: native
      .filter(
        (entry) =>
          entry.kind === "mcp" &&
          recordedVariables(entry.value).includes(variable),
      )
      .map((entry) => ({ file: entry.file, server: entry.key })),
  }));
}
