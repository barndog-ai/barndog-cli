import { homedir } from "node:os";
import crossSpawn from "cross-spawn";
import { isWindows, stopProcessTree } from "../platform.js";
import { mcpDefinitionSchema } from "@barndog-ai/api-contract";
import { CliError } from "../errors.js";

/** Allow two seconds for the MCP child to exit before forcing shutdown. */
const MCP_SHUTDOWN_GRACE_MS = 2000;

// This process runs only when the native harness starts a selected stdio MCP.
// Definitions contain references, never credential values. No shell is involved.
try {
  const definition = mcpDefinitionSchema.parse(
    JSON.parse(
      Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8"),
    ),
  );

  if (definition.transport !== "stdio") {
    throw new Error("A stdio configuration is required");
  }

  const runtime = {
    home: homedir(),
    cwd: process.cwd(),
    env: { ...process.env },
    platform: process.platform,
  };

  const env = { ...runtime.env };
  for (const [name, reference] of Object.entries(definition.environment)) {
    if (!runtime.env[reference.secretRef]) {
      throw new CliError(
        `${reference.secretRef} isn't set in your environment. Set it, then restart your coding tool.`,
      );
    }

    env[name] = runtime.env[reference.secretRef];
  }

  // cross-spawn finds the command on PATH and also starts Windows .cmd shims
  // (such as npx) with safely quoted arguments.
  const child = crossSpawn(definition.command, definition.args, {
    env,
    stdio: "inherit",
    detached: !isWindows(runtime.platform),
    cwd: runtime.cwd,
    windowsHide: true,
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      const { pid } = child;
      if (!pid) {
        return;
      }

      try {
        stopProcessTree(child, runtime, signal);

        const timer = setTimeout(() => {
          try {
            stopProcessTree(child, runtime);
          } catch {
            /* exited */
          }
        }, MCP_SHUTDOWN_GRACE_MS);

        timer.unref();
      } catch {
        /* already exited */
      }
    });
  }

  child.once("error", () => {
    console.error("Unable to start the configured MCP command");
    process.exitCode = 1;
  });

  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Invalid MCP configuration.",
  );

  process.exitCode = 1;
}
