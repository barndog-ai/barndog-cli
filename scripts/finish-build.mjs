// Runs after tsc: applies build-time settings and restores the executable bit
// that deleting dist/ removes from an npm-linked CLI.
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const output =
  process.argv[2] ?? fileURLToPath(new URL("../dist", import.meta.url));
const { normalizeServer } = await import("../dist/features/auth/transport.js");

try {
  // Never replaces a variable already set in the shell.
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const server = process.env.BARNDOG_DEFAULT_SERVER?.trim();

if (server) {
  let normalized;

  try {
    normalized = normalizeServer(server);
  } catch {
    console.error(
      `BARNDOG_DEFAULT_SERVER must be an HTTPS origin (HTTP is allowed for localhost): ${server}`,
    );
    process.exit(1);
  }

  await writeFile(
    join(output, "config/build.js"),
    `export const defaultServer = ${JSON.stringify(normalized)};\n`,
  );
}

await chmod(join(output, "cli.js"), 0o755);
