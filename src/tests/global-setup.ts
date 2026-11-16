import { execFileSync } from "node:child_process";

// Builds dist/ once per run for the tests that start the CLI as a process.
// On Windows pnpm is a .cmd file, which Node starts only through a shell.
export default function setup() {
  execFileSync("pnpm", ["run", "build"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
}
