/**
 * `barndog mcp env`: the MCP variable values BarnDog keeps on this machine,
 * each for one MCP server. Each change syncs at once, so the coding tools'
 * settings hold the new value, or a reference again once it is forgotten.
 */
import type { RuntimeContext } from "../../runtime.js";
import { readState } from "../../config/state.js";
import { CliError } from "../../errors.js";
import type { SyncEvent } from "../environment/events.js";
import {
  keptValues,
  updateKeptValues,
  withServerValues,
} from "../environment/kept-values.js";
import { synchronize } from "../environment/sync.js";
import { inventory, type InventoryItem } from "../inventory/index.js";
import {
  assertVariableName,
  literalOf,
  readsFrom,
  type KeptValue,
} from "../secrets/index.js";

/** What changing a kept value did: the file it's kept in, and the sync that followed. */
export type KeptValueChange = { file: string; events: SyncEvent[] };

/** One variable of one MCP server, as `mcp env` names it. */
export type ServerVariable = { server: string; variable: string };

/**
 * A kept value and where sync wrote it; never the value itself. `server` is
 * null for a value from a version 1 file that no server has yet.
 */
export type KeptVariable = {
  server: string | null;
  assetId: string | null;
  variable: string;
  /** The variable the server reads instead, when it was told to. */
  from?: string;
  writtenTo: string[];
};

/** The MCP server called `name` on this machine: its installed name, published name or asset ID. */
async function findServer(
  name: string,
  runtime: RuntimeContext,
): Promise<InventoryItem> {
  const { items } = await inventory(runtime, { checkVariables: true });
  const matches = items.filter(
    (item) =>
      item.kind === "mcp" &&
      [item.installedName, item.name, item.id].includes(name),
  );

  const exact = matches.filter((item) => item.installedName === name);
  const [only] = exact.length === 1 ? exact : matches;
  if (!only || matches.length > 1) {
    throw new CliError(
      only
        ? `More than one MCP server is called ${name}.`
        : `There's no MCP server called ${name} on this machine.`,
      "barndog mcp list",
    );
  }

  return only;
}

function assertUses(server: InventoryItem, variable: string) {
  assertVariableName(variable);
  if (server.variables && !server.variables.includes(variable)) {
    throw new CliError(
      server.variables.length
        ? `${server.installedName} doesn't use ${variable}. It uses ${server.variables.join(", ")}.`
        : `${server.installedName} doesn't use any variables.`,
      `barndog mcp show ${server.installedName}`,
    );
  }
}

async function changed(
  file: string,
  runtime: RuntimeContext,
): Promise<KeptValueChange> {
  return { file, events: await synchronize(undefined, runtime) };
}

/** Keeps a value, or another variable to read, for one server's variable and writes it into the coding tools. */
export async function keepMcpValue(
  target: ServerVariable,
  kept: KeptValue,
  runtime: RuntimeContext,
): Promise<KeptValueChange> {
  const server = await findServer(target.server, runtime);
  assertUses(server, target.variable);
  const fix = `barndog mcp env set ${server.installedName} ${target.variable}`;
  const from = readsFrom(kept);
  if (literalOf(kept) === "") {
    throw new CliError(
      `The value for ${target.variable} is empty, so nothing was kept.`,
      fix,
    );
  }

  if (from !== undefined) {
    assertVariableName(from);
    if (from === target.variable) {
      throw new CliError(
        `${target.variable} already reads ${from} from the environment.`,
        `barndog mcp env unset ${server.installedName} ${target.variable}`,
      );
    }
  }

  const file = await updateKeptValues(
    (secrets) =>
      withServerValues(secrets, server.id, { [target.variable]: kept }),
    runtime,
  );

  return changed(file, runtime);
}

/** Gives a value kept before values belonged to servers to one server. */
export async function assignKeptValue(
  target: ServerVariable,
  runtime: RuntimeContext,
): Promise<KeptValueChange> {
  const server = await findServer(target.server, runtime);
  assertUses(server, target.variable);
  const value = (await keptValues(runtime)).unassigned[target.variable];
  if (value === undefined) {
    throw new CliError(
      `BarnDog has no unassigned value for ${target.variable}.`,
      `barndog mcp env set ${server.installedName} ${target.variable}`,
    );
  }

  const file = await updateKeptValues((secrets) => {
    const unassigned = { ...secrets.unassigned };
    delete unassigned[target.variable];

    return withServerValues({ ...secrets, unassigned }, server.id, {
      [target.variable]: { value },
    });
  }, runtime);

  return changed(file, runtime);
}

/** Forgets one server's kept value; the tools read the variable again. */
export async function forgetMcpValue(
  target: ServerVariable,
  runtime: RuntimeContext,
): Promise<KeptValueChange> {
  const secrets = await keptValues(runtime);
  // A server that's gone is still named by the asset ID `mcp env list` shows.
  const id = Object.hasOwn(secrets.servers, target.server)
    ? target.server
    : (await findServer(target.server, runtime)).id;

  if (!secrets.servers[id]?.[target.variable]) {
    throw new CliError(
      `BarnDog doesn't keep ${target.variable} for ${target.server}.`,
      "barndog mcp env list",
    );
  }

  const file = await updateKeptValues(
    (latest) => withServerValues(latest, id, { [target.variable]: null }),
    runtime,
  );

  return changed(file, runtime);
}

/** Forgets a value kept before values belonged to servers. */
export async function forgetUnassignedValue(
  variable: string,
  runtime: RuntimeContext,
): Promise<KeptValueChange> {
  if ((await keptValues(runtime)).unassigned[variable] === undefined) {
    throw new CliError(
      `BarnDog has no unassigned value for ${variable}.`,
      "barndog mcp env list",
    );
  }

  const file = await updateKeptValues((secrets) => {
    const unassigned = { ...secrets.unassigned };
    delete unassigned[variable];

    return { ...secrets, unassigned };
  }, runtime);

  return changed(file, runtime);
}

/** Every kept value, by server, with the settings files sync wrote it into. */
export async function listKeptValues(
  runtime: RuntimeContext,
): Promise<KeptVariable[]> {
  const secrets = await keptValues(runtime);
  const { native } = await readState(runtime.home);
  const servers = native.filter((entry) => entry.kind === "mcp");

  const assigned = Object.entries(secrets.servers).flatMap(([id, values]) => {
    const entries = servers.filter((entry) => entry.id === id);
    const name = entries[0]?.key ?? id;

    return Object.entries(values).map(([variable, kept]) => {
      const from = readsFrom(kept);

      return {
        server: name,
        assetId: id,
        variable,
        ...(from ? { from } : {}),
        writtenTo: [...new Set(entries.map((entry) => entry.file))],
      };
    });
  });

  const unassigned = Object.keys(secrets.unassigned).map((variable) => ({
    server: null,
    assetId: null,
    variable,
    writtenTo: [],
  }));

  const byName = (a: KeptVariable, b: KeptVariable) =>
    (a.server ?? "").localeCompare(b.server ?? "") ||
    a.variable.localeCompare(b.variable);

  // Values no server has come last.
  return [...assigned.sort(byName), ...unassigned.sort(byName)];
}
