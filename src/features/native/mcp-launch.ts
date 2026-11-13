import { spawn } from "node:child_process";
import { mcpDefinitionSchema } from "@barndog-ai/api-contract";

// This process runs only when the native harness starts a selected stdio MCP.
// Definitions contain references, never credential values. No shell is involved.
try {
  const definition = mcpDefinitionSchema.parse(
    JSON.parse(
      Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8"),
    ),
  );
  if (definition.transport !== "stdio")
    throw new Error("A stdio configuration is required");
  const env = { ...process.env };
  for (const [name, reference] of Object.entries(definition.environment)) {
    if (!process.env[reference.secretRef])
      throw new Error(
        `Missing local environment variable: ${reference.secretRef}`,
      );
    env[name] = process.env[reference.secretRef];
  }
  const child = spawn(definition.command, definition.args, {
    env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      const { pid } = child;
      if (!pid) return;
      try {
        if (process.platform !== "win32") process.kill(-pid, signal);
        else child.kill(signal);
        const timer = setTimeout(() => {
          try {
            if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            /* exited */
          }
        }, 2000);
        timer.unref();
      } catch {
        /* already exited */
      }
    });
  child.once("error", () => {
    console.error("Unable to start the configured MCP command");
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Invalid MCP configuration",
  );
  process.exitCode = 1;
}
