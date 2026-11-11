import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Runs at session start. It must return at once and can never fail the session,
// so the real sync happens in a detached process that outlives this one.
try {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../../cli.js", import.meta.url)), "sync", "--auto"],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, HOME: process.argv[2] },
    },
  );
  child.on("error", () => {});
  child.unref();
} catch {
  // A missed background sync is picked up by the next session or barndog sync.
}
