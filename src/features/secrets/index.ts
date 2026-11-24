/**
 * Values of MCP variables that BarnDog keeps for the developer, in
 * `~/.barndog/secrets.json`. The file stays on this machine: nothing here is
 * uploaded, shared definitions keep only `{ "secretRef": "NAME" }`, and sync
 * writes each value into the coding tools' own settings, as the tools store
 * values they're given. Like `credentials.json`, only the user can read it.
 *
 * Each value belongs to one MCP server, by asset ID, so two servers can keep
 * different values for one variable name. Version 1 files kept one value per
 * variable for every server; `environment/kept-values.ts` converts them.
 */
import type { RuntimeContext } from "../../runtime.js";
import type { McpDefinition } from "@barndog-ai/api-contract";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { z } from "zod";

import { barndogPaths } from "../../config/paths.js";
import { CliError } from "../../errors.js";
import { secretRefs } from "../../harnesses/formats.js";
import type { KeptValues } from "../../harnesses/types.js";
import {
  privatePermissions,
  protectPrivate,
  removeCommand,
} from "../../platform.js";
import { POSIX_MODE } from "../../shared/constants.js";
import { ifExists, writeAtomic } from "../../shared/files.js";
import { withPidLock } from "../../shared/lock.js";
import { VARIABLE_NAME } from "../../shared/patterns.js";
import { posixQuote } from "../../shared/shell.js";

const variable = z.string().regex(new RegExp(`^${VARIABLE_NAME.source}$`));

/** A kept value, or another environment variable the server reads in its place. */
const keptValueSchema = z.union([
  z.strictObject({ value: z.string() }),
  z.strictObject({ from: variable }),
]);

const secretsSchema = z.discriminatedUnion("version", [
  z.strictObject({
    version: z.literal(1),
    values: z.record(variable, z.string()),
  }),
  z.strictObject({
    version: z.literal(2),
    /** MCP asset ID → variable → its value. */
    servers: z.record(z.string(), z.record(variable, keptValueSchema)),
    /** Values from a version 1 file that no installed server was using. */
    unassigned: z.record(variable, z.string()),
  }),
]);

export type KeptValue = z.infer<typeof keptValueSchema>;

/** The variable a kept value says to read instead; undefined for a value kept as written. */
export const readsFrom = (kept: KeptValue | undefined) =>
  kept && "from" in kept ? kept.from : undefined;

/** The value kept as written; undefined for one that reads another variable. */
export const literalOf = (kept: KeptValue | undefined) =>
  kept && "value" in kept ? kept.value : undefined;

/** One server's kept values, by the variable its definition names. */
export type ServerValues = Readonly<Record<string, KeptValue>>;

/** The values BarnDog keeps, per MCP server. */
export type Secrets = {
  servers: Readonly<Record<string, ServerValues>>;
  unassigned: Readonly<Record<string, string>>;
};

/** `secrets.json` as written: the current shape, or a version 1 file. */
export type StoredSecrets = z.infer<typeof secretsSchema>;

const empty: StoredSecrets = { version: 2, servers: {}, unassigned: {} };

/** The file as stored; an empty current one when there's no file yet. */
export async function readStoredSecrets(
  runtime: RuntimeContext,
): Promise<StoredSecrets> {
  const path = barndogPaths(runtime.home).secrets;
  const info = await ifExists(lstat(path));
  if (!info) {
    return empty;
  }

  if (!info.isFile()) {
    throw new CliError(
      `${path} isn't a regular file, so BarnDog can't read the MCP values it keeps.`,
      "Delete it, then set the values again with barndog mcp env set.",
      { command: removeCommand(path, runtime.platform) },
    );
  }

  // Always passes on Windows, where the ACL set on every write keeps it private.
  if (!privatePermissions(info.mode, runtime.platform)) {
    throw new CliError(
      `${path} can be read by other users on this machine.`,
      "Make it readable and writable only by you.",
      { command: `chmod 600 ${posixQuote(path)}` },
    );
  }

  const parsed = secretsSchema.safeParse(
    parseJson(await readFile(path, "utf8")),
  );

  if (!parsed.success) {
    throw new CliError(
      `${path} is damaged, so BarnDog can't read the MCP values it keeps.`,
      "Delete it, then set the values again with barndog mcp env set.",
      { command: removeCommand(path, runtime.platform) },
    );
  }

  return parsed.data;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Replaces the file with what `change` makes of it, under a lock, and returns
 * the file's path and what it now holds. `change` receives the file as stored,
 * so a version 1 file has to be converted there.
 */
export async function changeSecrets(
  change: (current: StoredSecrets) => Secrets,
  runtime: RuntimeContext,
): Promise<{ file: string; secrets: Secrets }> {
  const paths = barndogPaths(runtime.home);
  await mkdir(paths.root, {
    recursive: true,
    mode: POSIX_MODE.privateDirectory,
  });

  await chmod(paths.root, POSIX_MODE.privateDirectory);
  await protectPrivate(paths.root, runtime);

  const secrets = await withPidLock(
    paths.secretsLock,
    {
      starting:
        "Another change to the kept MCP values is starting. Wait for it to finish, then try again.",
      running:
        "Another change to the kept MCP values is running. Wait for it to finish, then try again.",
    },
    async () => {
      const next = withoutEmptyServers(
        change(await readStoredSecrets(runtime)),
      );

      await writeAtomic(
        paths.secrets,
        JSON.stringify({ version: 2, ...next }, null, 2) + "\n",
      );

      await protectPrivate(paths.secrets, runtime);

      return next;
    },
  );

  return { file: paths.secrets, secrets };
}

function withoutEmptyServers(secrets: Secrets): Secrets {
  return {
    servers: Object.fromEntries(
      Object.entries(secrets.servers).filter(
        ([, values]) => Object.keys(values).length > 0,
      ),
    ),
    unassigned: secrets.unassigned,
  };
}

/** Throws unless `name` can be an environment variable's name. */
export function assertVariableName(name: string) {
  if (!variable.safeParse(name).success) {
    throw new CliError(
      `${name} isn't an environment variable name.`,
      "Use letters, digits and underscores, not starting with a digit.",
    );
  }
}

/**
 * A server's definition with each variable kept as `from` read from that other
 * variable instead, and the values written into its entries as they are.
 */
export function applyKeptValues(
  definition: McpDefinition,
  values: ServerValues = {},
): { definition: McpDefinition; kept: KeptValues } {
  const rewrite = (refs: Readonly<Record<string, { secretRef: string }>>) =>
    Object.fromEntries(
      Object.entries(refs).map(([key, ref]) => {
        const from = readsFrom(values[ref.secretRef]);

        return [key, from ? { ...ref, secretRef: from } : ref];
      }),
    );

  const kept = Object.fromEntries(
    Object.entries(values).flatMap(([name, value]) => {
      const literal = literalOf(value);

      return literal === undefined ? [] : [[name, literal] as const];
    }),
  );

  return {
    definition:
      definition.transport === "stdio"
        ? { ...definition, environment: rewrite(definition.environment) }
        : { ...definition, headers: rewrite(definition.headers) },
    kept,
  };
}

/**
 * A variable a server's definition names that has no value here, and the
 * variable it was told to read instead, when it was.
 */
export type MissingValue = { variable: string; from?: string };

/**
 * The variables a definition names that have no value on this machine:
 * BarnDog keeps none for this server and `env` doesn't set the variable read,
 * even to an empty string. Each once, in the order the definition names them.
 */
export function missingValues(
  definition: McpDefinition,
  values: ServerValues,
  env: NodeJS.ProcessEnv,
): MissingValue[] {
  const missing = new Map<string, MissingValue>();
  for (const { secretRef } of Object.values(secretRefs(definition))) {
    const kept = values[secretRef];
    const from = readsFrom(kept);
    const read = from ?? secretRef;
    const found =
      literalOf(kept) ??
      literalOf(from ? values[from] : undefined) ??
      env[read];

    // An empty value is still a value: a tool passes it as it is.
    if (found === undefined) {
      missing.set(secretRef, {
        variable: secretRef,
        ...(from ? { from } : {}),
      });
    }
  }

  return [...missing.values()];
}
