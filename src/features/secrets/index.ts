/**
 * Values of MCP variables that BarnDog keeps for the developer, in
 * `~/.barndog/secrets.json`. The file stays on this machine: nothing here is
 * uploaded, shared definitions keep only `{ "secretRef": "NAME" }`, and sync
 * writes each value into the coding tools' own settings, as the tools store
 * values they're given. Like `credentials.json`, only the user can read it.
 */
import type { RuntimeContext } from "../../runtime.js";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { z } from "zod";

import { barndogPaths } from "../../config/paths.js";
import { CliError } from "../../errors.js";
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

const secretsSchema = z.strictObject({
  version: z.literal(1),
  values: z.record(variable, z.string()),
});

/** Variable name → value, for the variables BarnDog keeps. */
export type Secrets = Readonly<Record<string, string>>;

/** The kept values; empty when there's no file yet. */
export async function readSecrets(runtime: RuntimeContext): Promise<Secrets> {
  const path = barndogPaths(runtime.home).secrets;
  const info = await ifExists(lstat(path));
  if (!info) {
    return {};
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

  return parsed.data.values;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Saves `changes` (a value, or null to forget it) under a lock; returns the file's path. */
export async function updateSecrets(
  changes: Readonly<Record<string, string | null>>,
  runtime: RuntimeContext,
): Promise<string> {
  const paths = barndogPaths(runtime.home);
  for (const name of Object.keys(changes)) {
    if (!variable.safeParse(name).success) {
      throw new CliError(
        `${name} isn't an environment variable name.`,
        "Use letters, digits and underscores, not starting with a digit.",
      );
    }
  }

  await mkdir(paths.root, {
    recursive: true,
    mode: POSIX_MODE.privateDirectory,
  });

  await chmod(paths.root, POSIX_MODE.privateDirectory);
  await protectPrivate(paths.root, runtime);
  await withPidLock(
    paths.secretsLock,
    {
      starting:
        "Another change to the kept MCP values is starting. Wait for it to finish, then try again.",
      running:
        "Another change to the kept MCP values is running. Wait for it to finish, then try again.",
    },
    async () => {
      const values: Record<string, string> = {
        ...(await readSecrets(runtime)),
      };

      for (const [name, value] of Object.entries(changes)) {
        if (value === null) {
          delete values[name];
        } else {
          values[name] = value;
        }
      }

      await writeAtomic(
        paths.secrets,
        JSON.stringify({ version: 1, values }, null, 2) + "\n",
      );

      await protectPrivate(paths.secrets, runtime);
    },
  );

  return paths.secrets;
}
