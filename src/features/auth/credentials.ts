import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { contextSchema, type ActorContext } from "@barndog-ai/api-contract";
import { z } from "zod";
import { errorCode } from "../../errors.js";

/** A BarnDog session token: 32 random bytes in unpadded base64url, 43 characters. */
export const SESSION_TOKEN = /^[\w-]{43}$/;

export type Credential = {
  token: string;
  expiresAt: string;
  context: ActorContext;
};

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

export async function readCredentials(home = homedir()): Promise<Credentials> {
  const path = join(home, ".barndog", "credentials.json");
  try {
    const info = await lstat(path);
    if (!info.isFile() || (process.platform !== "win32" && info.mode & 0o077))
      throw new Error(
        "Credentials file must be a regular file accessible only to its owner",
      );
    const parsed = credentialsSchema.safeParse(
      JSON.parse(await readFile(path, "utf8")),
    );
    if (!parsed.success) throw new Error("Invalid credentials file");
    return parsed.data;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { version: 1, servers: {} };
    throw error;
  }
}

export async function updateCredentials(
  home: string,
  update: (credentials: Credentials) => void,
) {
  const root = join(home, ".barndog");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory())
    throw new Error("Credentials directory must be a regular directory");
  await chmod(root, 0o700);
  const lock = join(root, "credentials.lock");
  await mkdir(lock, { mode: 0o700 }).catch((error: unknown) => {
    if (errorCode(error) === "EEXIST")
      throw new Error("Another login or logout is running");
    throw error;
  });
  const temporary = join(root, `credentials.${randomUUID()}.tmp`);
  try {
    const credentials = await readCredentials(home);
    update(credentials);
    await writeFile(temporary, JSON.stringify(credentials, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, join(root, "credentials.json"));
  } finally {
    await rm(temporary, { force: true });
    await rm(lock, { recursive: true });
  }
}
