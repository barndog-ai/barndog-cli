import { execFileSync } from "node:child_process";

// Builds dist/ once per run for the tests that start the CLI as a process.
export default function setup() {
  execFileSync("pnpm", ["run", "build"], { stdio: "ignore" });
}
