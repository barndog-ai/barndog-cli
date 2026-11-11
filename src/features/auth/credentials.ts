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

export type Credential = {
  token: string;
  expiresAt: string;
  context: ActorContext;
};

type Credentials = {
  version: 1;
  selectedServer?: string;
  servers: Record<string, Credential>;
};

export async function readCredentials(home = homedir()): Promise<Credentials> {
  const path = join(home, ".barndog", "credentials.json");
  try {
    const info = await lstat(path);
    if (!info.isFile() || (process.platform !== "win32" && info.mode & 0o077))
      throw new Error(
        "Credentials file must be a regular file accessible only to its owner",
      );
    const value = JSON.parse(await readFile(path, "utf8")) as Credentials;
    if (
      value.version !== 1 ||
      !value.servers ||
      typeof value.servers !== "object" ||
      Array.isArray(value.servers) ||
      (value.selectedServer !== undefined &&
        typeof value.selectedServer !== "string")
    )
      throw new Error("Invalid credentials file");
    for (const entry of Object.values(value.servers)) {
      if (
        !entry ||
        !/^[A-Za-z0-9_-]{43}$/.test(entry.token) ||
        !Number.isFinite(Date.parse(entry.expiresAt))
      )
        throw new Error("Invalid credentials file");
      contextSchema.parse(entry.context);
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, servers: {} };
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
  await mkdir(lock, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST")
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
