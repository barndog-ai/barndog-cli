import { POSIX_MODE } from "../../shared/constants.js";

import { chmod, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { contextSchema } from "@barndog-ai/api-contract";
import { z } from "zod";
import { errorCode } from "../../shared/values.js";
import { ifExists, writeAtomic } from "../../shared/files.js";
import { CliError } from "../../errors.js";
import { barndogPaths } from "../../config/paths.js";

/**
 * A BarnDog session token: 32 random bytes in unpadded base64url, 43 characters.
 *
 * @internal Exported for its table test in `src/tests/patterns.test.ts`.
 */
export const SESSION_TOKEN = /^[\w-]{43}$/;

const credentialsSchema = z.looseObject({
  version: z.literal(1),
  selectedServer: z.string().optional(),
  servers: z.record(
    z.string(),
    z.looseObject({
      token: z.string().regex(SESSION_TOKEN),
      expiresAt: z
        .string()
        .refine((value) => Number.isFinite(Date.parse(value))),
      context: contextSchema,
    }),
  ),
});

type Credentials = z.infer<typeof credentialsSchema>;

/**
 * Reads saved sessions under the supplied home; rejects insecure POSIX
 * permissions and returns empty state if absent.
 */
export async function readCredentials(home = homedir()): Promise<Credentials> {
  const path = barndogPaths(home).credentials;
  const info = await ifExists(lstat(path));
  if (!info) {
    return { version: 1, servers: {} };
  }

  if (
    !info.isFile() ||
    (process.platform !== "win32" && info.mode & POSIX_MODE.groupAndOtherBits)
  ) {
    throw new CliError(
      `${path} must be a regular file only you can read.`,
      `chmod 600 ${path}`,
    );
  }

  const parsed = credentialsSchema.safeParse(
    parseJson(await readFile(path, "utf8")),
  );

  if (!parsed.success) {
    throw new CliError(
      `${path} is damaged, so BarnDog can't read your sign-ins.`,
      `rm ${path} && barndog login`,
    );
  }

  return parsed.data;
}

/** JSON, or undefined when the text isn't JSON, so the schema reports it as damaged. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Locks credentials under the supplied home, applies a synchronous update and
 * atomically saves the result.
 */
export async function updateCredentials(
  home: string,
  update: (credentials: Credentials) => void,
) {
  const root = barndogPaths(home).root;
  await mkdir(root, { recursive: true, mode: POSIX_MODE.privateDirectory });
  const info = await lstat(root);
  if (!info.isDirectory()) {
    throw new CliError(`${root} must be a folder.`);
  }

  await chmod(root, POSIX_MODE.privateDirectory);
  const lock = barndogPaths(home).credentialsLock;
  await mkdir(lock, { mode: POSIX_MODE.privateDirectory }).catch(
    (error: unknown) => {
      if (errorCode(error) === "EEXIST") {
        throw new CliError(
          "Another sign-in or sign-out is running. Wait for it to finish, then try again.",
        );
      }

      throw error;
    },
  );

  try {
    const credentials = await readCredentials(home);
    update(credentials);
    await writeAtomic(
      barndogPaths(home).credentials,
      JSON.stringify(credentials, null, 2) + "\n",
    );
  } finally {
    await rm(lock, { recursive: true });
  }
}
