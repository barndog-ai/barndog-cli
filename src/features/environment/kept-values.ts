/**
 * The MCP values BarnDog keeps (`features/secrets/`), converting a version 1
 * `secrets.json` on first use. Version 1 kept one value per variable for every
 * server; `state.json` records which entries sync wrote each into, so each
 * value now belongs to those servers, and a value no entry holds is kept as
 * unassigned until the developer gives it to a server.
 */
import type { RuntimeContext } from "../../runtime.js";
import { readState, type State } from "../../config/state.js";
import { recordedVariables } from "../native/secret-values.js";
import {
  changeSecrets,
  readStoredSecrets,
  type KeptValue,
  type Secrets,
  type StoredSecrets,
} from "../secrets/index.js";

function converted(values: Readonly<Record<string, string>>, state: State) {
  const servers: Record<string, Record<string, KeptValue>> = {};
  const assigned = new Set<string>();
  for (const entry of state.native) {
    if (entry.kind !== "mcp") {
      continue;
    }

    for (const variable of recordedVariables(entry.value)) {
      const value = values[variable];
      if (value !== undefined) {
        servers[entry.id] = { ...servers[entry.id], [variable]: { value } };
        assigned.add(variable);
      }
    }
  }

  return {
    servers,
    unassigned: Object.fromEntries(
      Object.entries(values).filter(([variable]) => !assigned.has(variable)),
    ),
  };
}

const upgraded = (stored: StoredSecrets, state: State): Secrets =>
  stored.version === 2 ? stored : converted(stored.values, state);

/** The kept values, converting a version 1 file first. */
export async function keptValues(runtime: RuntimeContext): Promise<Secrets> {
  const stored = await readStoredSecrets(runtime);
  if (stored.version === 2) {
    return stored;
  }

  const state = await readState(runtime.home);
  const { secrets } = await changeSecrets(
    (latest) => upgraded(latest, state),
    runtime,
  );

  return secrets;
}

/** Saves what `change` makes of the kept values; returns the file's path. */
export async function updateKeptValues(
  change: (secrets: Secrets) => Secrets,
  runtime: RuntimeContext,
): Promise<string> {
  const state = await readState(runtime.home);
  const { file } = await changeSecrets(
    (latest) => change(upgraded(latest, state)),
    runtime,
  );

  return file;
}

/** `secrets` with `values` set for the server with asset ID `id`; null forgets that variable's value. */
export function withServerValues(
  secrets: Secrets,
  id: string,
  values: Readonly<Record<string, KeptValue | null>>,
): Secrets {
  const server: Record<string, KeptValue> = { ...secrets.servers[id] };
  for (const [variable, value] of Object.entries(values)) {
    if (value === null) {
      delete server[variable];
    } else {
      server[variable] = value;
    }
  }

  return { ...secrets, servers: { ...secrets.servers, [id]: server } };
}

/**
 * A server whose asset ID changes, as when a local MCP server moves into the
 * shared workspace. `copy` keeps the old server's values too, for a local copy
 * that stays as its own asset.
 */
export type ServerMove = { from: string; to: string; copy: boolean };

/** `secrets` with each moved server's values under its new asset ID. */
export function withMovedServers(
  secrets: Secrets,
  moves: readonly ServerMove[],
): Secrets {
  const servers = { ...secrets.servers };
  for (const { from, to, copy } of moves) {
    const values = servers[from];
    if (!values) {
      continue;
    }

    servers[to] = { ...values, ...servers[to] };
    if (!copy) {
      delete servers[from];
    }
  }

  return { ...secrets, servers };
}
