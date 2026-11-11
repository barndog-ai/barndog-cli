import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/tests/**/*.test.ts"],
    setupFiles: ["src/tests/setup.ts"],
    globalSetup: ["src/tests/global-setup.ts"],
    // Several tests drive real Git repositories and child processes.
    testTimeout: 30_000,
  },
});
