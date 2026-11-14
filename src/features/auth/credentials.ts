import { POSIX_MODE } from "../../shared/constants.js";

import { chmod, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { contextSchema } from "@barndog-ai/api-contract";
import { z } from "zod";
import { errorCode } from "../../shared/values.js";
import { writeAtomic } from "../../shared/files.js";

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
  const path = join(home, ".barndog", "credentials.json");
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      (process.platform !== "win32" && info.mode & POSIX_MODE.groupAndOtherBits)
    ) {
      throw new Error(
        "Credentials file must be a regular file accessible only to its owner",
      );
    }

    const parsed = credentialsSchema.safeParse(
      JSON.parse(await readFile(path, "utf8")),
    );

    if (!parsed.success) {
      throw new Error("Invalid credentials file");
    }

    return parsed.data;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { version: 1, servers: {} };
    }

    throw error;
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
  const root = join(home, ".barndog");
  await mkdir(root, { recursive: true, mode: POSIX_MODE.privateDirectory });
  const info = await lstat(root);
  if (!info.isDirectory()) {
    throw new Error("Credentials directory must be a regular directory");
  }

  await chmod(root, POSIX_MODE.privateDirectory);
  const lock = join(root, "credentials.lock");
  await mkdir(lock, { mode: POSIX_MODE.privateDirectory }).catch(
    (error: unknown) => {
      if (errorCode(error) === "EEXIST") {
        throw new Error("Another login or logout is running");
      }

      throw error;
    },
  );

  try {
    const credentials = await readCredentials(home);
    update(credentials);
    await writeAtomic(
      join(root, "credentials.json"),
      JSON.stringify(credentials, null, 2) + "\n",
    );
  } finally {
    await rm(lock, { recursive: true });
  }
}
