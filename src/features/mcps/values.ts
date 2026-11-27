/**
 * `barndog mcp env`: the MCP variable values BarnDog keeps on this machine,
 * each for one MCP server. Servers are looked up in the record the last sync
 * left in `state.json`, never in the workspace, so these work offline. A change
 * for an enabled server syncs at once, so the coding tools' settings hold the
 * new value, or a reference again once it is forgotten; a disabled server has
 * no entries to update until it is enabled.
 */
import type { RuntimeContext } from "../../runtime.js";
import { readState, type McpServerRecord } from "../../config/state.js";
import { CliError, friendlyMessage } from "../../errors.js";
import { LoginRequiredError } from "../auth/transport.js";
import type { SyncEvent } from "../environment/events.js";
import {
  keptValues,
  updateKeptValues,
  withServerValues,
} from "../environment/kept-values.js";
import { synchronize } from "../environment/sync.js";
import {
  assertVariableName,
  literalOf,
  readsFrom,
  type KeptValue,
} from "../secrets/index.js";

/**
 * Why a kept value isn't in the coding tools' settings yet: the server is
 * disabled, or the sync after the change failed (a sentence, and its fix when
 * there is one). The next sync that runs writes it.
 */
type NotWritten =
  | { because: "disabled" }
  | { because: "sync-failed"; message: string; fix?: string };

/**
 * What changing a kept value did: the file it's kept in, the sync that
 * followed, and why the tools weren't updated when they weren't.
 */
export type KeptValueChange = {
  file: string;
  events: SyncEvent[];
  notWritten?: NotWritten;
};

/** One variable of one MCP server, as `mcp env` names it. */
export type ServerVariable = { server: string; variable: string };

/**
 * A kept value and where sync wrote it; never the value itself. `server` is
 * null for a value from a version 1 file that no server has yet.
 */
export type KeptVariable = {
  server: string | null;
  assetId: string | null;
  /** Null when BarnDog has no record of the server. */
  enabled: boolean | null;
  variable: string;
  /** The variable the server reads instead, when it was told to. */
  from?: string;
  writtenTo: string[];
};

/**
 * Every MCP server selected on this machine, disabled ones included, as the
 * last sync recorded them.
 */
export async function recordedMcpServers(
  runtime: RuntimeContext,
): Promise<McpServerRecord[]> {
  const { mcpServers } = await readState(runtime.home);
  if (!mcpServers) {
    throw new CliError(
      "BarnDog hasn't recorded this machine's MCP servers yet.",
      "barndog sync",
    );
  }

  return mcpServers;
}

/** The MCP server called `name` on this machine: its installed name, published name or asset ID. */
async function findServer(
  name: string,
  runtime: RuntimeContext,
): Promise<McpServerRecord> {
  const matches = (await recordedMcpServers(runtime)).filter((server) =>
    [server.installedName, server.name, server.id].includes(name),
  );

  const exact = matches.filter((server) => server.installedName === name);
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

function assertUses(server: McpServerRecord, variable: string) {
  assertVariableName(variable);
  if (!server.variables.includes(variable)) {
    throw new CliError(
      server.variables.length
        ? `${server.installedName} doesn't use ${variable}. It uses ${server.variables.join(", ")}.`
        : `${server.installedName} doesn't use any variables.`,
      `barndog mcp show ${server.installedName}`,
    );
  }
}

/**
 * Writes a changed value into the tools, unless the server is disabled. The
 * value is already kept, so a sync that fails says why and leaves it for the
 * next one instead of failing the change.
 */
async function deliver(
  file: string,
  server: McpServerRecord | undefined,
  runtime: RuntimeContext,
): Promise<KeptValueChange> {
  if (server && !server.enabled) {
    return { file, events: [], notWritten: { because: "disabled" } };
  }

  try {
    return { file, events: await synchronize(undefined, runtime) };
  } catch (error) {
    if (error instanceof CliError) {
      return {
        file,
        events: [],
        notWritten: {
          because: "sync-failed",
          message: error.message,
          ...(error.hint ? { fix: error.hint } : {}),
        },
      };
    }

    if (error instanceof LoginRequiredError) {
      return {
        file,
        events: [],
        notWritten: {
          because: "sync-failed",
          message: friendlyMessage(error),
          fix: "barndog login",
        },
      };
    }

    throw error;
  }
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

  return deliver(file, server, runtime);
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

  return deliver(file, server, runtime);
}

/** Forgets one server's kept value; the tools read the variable again. */
export async function forgetMcpValue(
  target: ServerVariable,
  runtime: RuntimeContext,
): Promise<KeptValueChange> {
  const secrets = await keptValues(runtime);
  const { mcpServers = [] } = await readState(runtime.home);
  // A server that's gone is still named by the asset ID `mcp env list` shows.
  const server = Object.hasOwn(secrets.servers, target.server)
    ? mcpServers.find((record) => record.id === target.server)
    : await findServer(target.server, runtime);

  const id = server?.id ?? target.server;

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

  return deliver(file, server, runtime);
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

  return deliver(file, undefined, runtime);
}

/** Every kept value, by server, with the settings files sync wrote it into. */
export async function listKeptValues(
  runtime: RuntimeContext,
): Promise<KeptVariable[]> {
  const secrets = await keptValues(runtime);
  const { native, mcpServers = [] } = await readState(runtime.home);
  const entries = native.filter((entry) => entry.kind === "mcp");

  const assigned = Object.entries(secrets.servers).flatMap(([id, values]) => {
    const record = mcpServers.find((server) => server.id === id);
    const written = entries.filter((entry) => entry.id === id);
    // A server that's gone has only its asset ID left.
    const name = record?.installedName ?? written[0]?.key ?? id;

    return Object.entries(values).map(([variable, kept]) => {
      const from = readsFrom(kept);

      return {
        server: name,
        assetId: id,
        enabled: record?.enabled ?? null,
        variable,
        ...(from ? { from } : {}),
        writtenTo: [...new Set(written.map((entry) => entry.file))],
      };
    });
  });

  const unassigned = Object.keys(secrets.unassigned).map((variable) => ({
    server: null,
    assetId: null,
    enabled: null,
    variable,
    writtenTo: [],
  }));

  const byName = (a: KeptVariable, b: KeptVariable) =>
    (a.server ?? "").localeCompare(b.server ?? "") ||
    a.variable.localeCompare(b.variable);

  // Values no server has come last.
  return [...assigned.sort(byName), ...unassigned.sort(byName)];
}
