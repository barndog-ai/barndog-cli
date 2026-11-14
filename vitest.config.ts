import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/tests/**/*.test.ts"],
    setupFiles: ["src/tests/setup.ts"],
    globalSetup: ["src/tests/global-setup.ts"],
    // Several tests drive real Git repositories and child processes.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/tests/**"],
      reporter: ["text-summary", "text", "html"],
      // Just below the measured numbers so coverage can't drop. Raise them as
      // gaps are filled. Code run only by the built CLI in child processes
      // (such as src/cli.ts) isn't counted.
      thresholds: {
        statements: 69,
        branches: 61,
        functions: 71,
        lines: 68,
      },
    },
  },
});
