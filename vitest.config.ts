import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/tests/**/*.test.ts"],
    setupFiles: ["src/tests/setup.ts"],
    globalSetup: ["src/tests/global-setup.ts"],
    // Several tests drive real Git repositories and child processes.
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/tests/**"],
      reporter: ["text-summary", "text", "html"],
      // Just below the measured numbers so coverage can't drop. Raise them as
      // gaps are filled. Code run only in child processes isn't counted.
      thresholds: {
        statements: 94.8,
        branches: 90.5,
        functions: 95.1,
        lines: 94.9,
      },
    },
  },
});
