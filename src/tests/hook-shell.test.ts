import { expect, test } from "vitest";

import {
  hookCommand,
  hookInvocation,
  programLine,
} from "../features/native/hook-shell.js";
import { testRuntime } from "./runtime.js";

const decoded = (line: string) =>
  Buffer.from(line.split(" ").at(-1) ?? "", "base64").toString("utf16le");

const root = "C:\\Users\\Alice's\\.barndog\\installed\\hooks\\audit";

test.for(["linux", "darwin"] as const)(
  "%s: every tool runs hooks in sh",
  (platform) => {
    for (const harness of ["claude", "codex", "cursor"] as const) {
      expect(hookCommand("/a b", "./check.sh", harness, platform)).toMatch(
        /^export BARNDOG_HOOK_ROOT='\/a b' \w+='\/a b'; \.\/check\.sh$/,
      );
    }

    // Byte-identical to earlier releases, so Codex doesn't ask to trust it again.
    expect(
      programLine(
        "codex",
        ["/bin/node", "a b.js", "codex", "/home/me"],
        platform,
      ),
    ).toBe("'/bin/node' 'a b.js' codex '/home/me'");
  },
);

test("Windows: Claude Code gets Bash with forward-slash paths", () => {
  expect(hookCommand(root, "./check.sh", "claude", "win32")).toBe(
    "export BARNDOG_HOOK_ROOT='C:/Users/Alice'\\''s/.barndog/installed/hooks/audit' CLAUDE_PLUGIN_ROOT='C:/Users/Alice'\\''s/.barndog/installed/hooks/audit'; ./check.sh",
  );

  expect(
    programLine("claude", ["C:\\Program Files\\node.exe", "x.js"], "win32"),
  ).toBe("'C:/Program Files/node.exe' x.js");
});

test("Windows: Cursor gets a PowerShell line", () => {
  expect(hookCommand(root, "./check.ps1", "cursor", "win32")).toBe(
    "$env:BARNDOG_HOOK_ROOT='C:\\Users\\Alice''s\\.barndog\\installed\\hooks\\audit'; $env:CURSOR_PLUGIN_ROOT='C:\\Users\\Alice''s\\.barndog\\installed\\hooks\\audit'; ./check.ps1",
  );

  expect(
    programLine("cursor", ["C:\\Program Files\\node.exe", "x.js"], "win32"),
  ).toBe("& 'C:\\Program Files\\node.exe' 'x.js'; exit $LASTEXITCODE");
});

test("Windows: Codex gets a readable PowerShell line, like Cursor", () => {
  expect(hookCommand(root, "./check.ps1", "codex", "win32")).toBe(
    "$env:BARNDOG_HOOK_ROOT='C:\\Users\\Alice''s\\.barndog\\installed\\hooks\\audit'; $env:PLUGIN_ROOT='C:\\Users\\Alice''s\\.barndog\\installed\\hooks\\audit'; ./check.ps1",
  );
});

test("hooks test runs a PowerShell tool's Hook in PowerShell on Windows", async () => {
  const runtime = testRuntime("C:\\Users\\Alice", { platform: "win32" });
  const invocation = await hookInvocation(root, "exit 2", "cursor", runtime);
  expect(invocation.command).toBe("powershell.exe");
  expect(decoded(invocation.args.join(" "))).toMatch(/; exit 2$/);
});

test("hooks test runs a Bash tool's Hook in sh on macOS and Linux", async () => {
  const runtime = testRuntime("/home/alice", { platform: "linux" });
  expect(await hookInvocation("/r", "true", "codex", runtime)).toEqual({
    command: "/bin/sh",
    args: ["-c", "export BARNDOG_HOOK_ROOT='/r' PLUGIN_ROOT='/r'; true"],
  });
});
