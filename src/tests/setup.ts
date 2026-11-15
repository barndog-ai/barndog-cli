// Loaded before every test file (see `setupFiles` in `vitest.config.ts`).
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Tests compare plain text, so output must not depend on the terminal running
// them: some terminals set FORCE_COLOR, which would otherwise color everything
// the CLI prints.
process.env.FORCE_COLOR = "0";

// Every function below the command layer takes `home`, and tests pass a
// temporary one. As a second line of defense the default home is a fresh empty
// directory, so code that reads the home directory itself (createProgram()
// without `home`, a CLI child process) can't reach the developer's real
// ~/.barndog/ or coding-tool settings. `os.homedir()` reads HOME on POSIX and
// USERPROFILE on Windows.
const defaultHome = mkdtempSync(join(tmpdir(), "barndog-default-home-"));
process.env.HOME = defaultHome;
process.env.USERPROFILE = defaultHome;

// Sync refuses a relocated coding-tool config; the developer's own setting
// must not decide whether a test passes.
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;

afterAll(() => {
  const written = existsSync(defaultHome) ? readdirSync(defaultHome) : [];
  rmSync(defaultHome, { recursive: true, force: true });

  if (written.length) {
    throw new Error(
      `A test in this file wrote to the default home directory (${written.join(", ")}). Pass a temporary \`home\` to the code under test.`,
    );
  }
});
