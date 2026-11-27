import { expect, test, type TestContext } from "vitest";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { cloud } from "./cloud.js";
import { POSIX_MODE } from "../shared/constants.js";
import { testRuntime } from "./runtime.js";
import { localWorkspace } from "../features/workspace/setup.js";
import { saveSettings } from "../config/settings.js";

/** A Hook written only for Claude Code, needing a command no machine has. */
const NEEDS_MISSING = [
  "name: lint-on-save",
  "description: Lints after edits",
  "implementations:",
  "  claude:",
  "    compatibility: supported",
  "    scripts: [run.sh]",
  "    requirements:",
  "      commands: [barndog-test-missing-runtime]",
  "    events:",
  "      PostToolUse:",
  "        - hooks:",
  "            - type: command",
  "              command: '${BARNDOG_HOOK_ROOT}/run.sh'",
  "",
].join("\n");

/** A Hook written only for Codex, which runs anywhere. */
const CODEX_ONLY = NEEDS_MISSING.replace("lint-on-save", "notify")
  .replace("  claude:", "  codex:")
  .replace("barndog-test-missing-runtime", "sh");

async function fixture(t: TestContext) {
  const server = await cloud(t);
  const runtime = testRuntime(server.home);
  const local = await localWorkspace(runtime);
  await saveSettings(
    { harnesses: ["claude", "codex"], localWorkspace: local },
    server.home,
  );

  for (const [name, manifest] of [
    ["lint-on-save", NEEDS_MISSING],
    ["notify", CODEX_ONLY],
  ] as const) {
    const folder = join(local.path, "org/hooks", name);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "hook.yaml"), manifest);
    await writeFile(join(folder, "run.sh"), "#!/bin/sh\n");
    await chmod(join(folder, "run.sh"), POSIX_MODE.executableFile);
  }

  await server.run(["sets", "install", "local", "--mode", "all"]);

  return server;
}

const plain = (text: string) => stripVTControlCharacters(text);

test("sync, list, doctor and compatibility agree on a Hook that can't run", async (t) => {
  const server = await fixture(t);

  const sync = plain(await server.run(["sync"]));
  expect(sync).toContain("1 Hook can't run in a tool it's written for.");
  expect(sync).toContain("Tip: barndog doctor");
  expect(sync).not.toMatch(/unsupported|No implementation/);

  const list = plain(await server.run(["hooks", "list"]));
  expect(list).toMatch(/lint-on-save\s+local\s+local\s+—\s+can't run/);
  expect(list).toMatch(/notify\s+local\s+local\s+Codex\s+installed/);
  expect(list).toContain(
    "Fix: barndog doctor  to see what 1 Hook needs to run",
  );

  const doctor = plain(await server.run(["doctor"]));
  expect(doctor).toMatch(
    /Hooks\s+1 Hook can't run in a tool it's written for\.\n\n\s+lint-on-save\s+Claude Code\s+needs the barndog-test-missing-runtime command/,
  );

  expect(doctor).toContain(
    "Tip: 2 Hooks are written for only some of your tools. barndog hooks compatibility --all  to see which",
  );

  const report: unknown = JSON.parse(await server.run(["doctor", "--json"]));
  expect(JSON.stringify(report)).not.toContain("hooks compatibility --all");

  const matrix = plain(await server.run(["hooks", "compatibility", "--all"]));
  expect(matrix).toMatch(/lint-on-save\s+! can't run\s+—/);
  expect(matrix).toMatch(/notify\s+—\s+✔ supported/);

  expect(
    JSON.parse(await server.run(["hooks", "compatibility", "--all", "--json"])),
  ).toMatchObject([
    {
      name: "lint-on-save",
      origin: "local",
      compatibility: [
        {
          harness: "claude",
          missingRequirements: [
            { type: "command", command: "barndog-test-missing-runtime" },
          ],
        },
        { harness: "codex", status: "unsupported" },
      ],
    },
    { name: "notify", origin: "local" },
  ]);
});

test("each missing tool requirement reads beside the requirement it belongs to", async () => {
  const { renderHookTools } = await import("../ui/hook-compatibility.js");
  const missing = [
    { type: "invalid-range", range: "bad" },
    { type: "tool-missing", range: ">=2" },
    { type: "version-unknown", range: ">=2" },
    { type: "version", range: ">=2", installed: "1.0.0" },
  ] as const;

  const statuses = missing.map((requirement) =>
    plain(
      renderHookTools("guard", [
        {
          harness: "claude",
          status: "supported",
          declared: true,
          implementation: {
            compatibility: "supported",
            scripts: [],
            requirements: { commands: [], harnessVersion: requirement.range },
            events: { Stop: [] },
          },
          missingRequirements: [requirement],
          runtimeIssue: "unused",
        },
      ]).join("\n"),
    ),
  );

  expect(statuses[0]).toMatch(/Claude Code bad\s+! not a valid version range/);
  expect(statuses[0]).toContain(
    "Fix: Ask the Hook's author to fix requirements.harnessVersion in hook.yaml",
  );

  expect(statuses[1]).toMatch(/! can't find Claude Code/);
  expect(statuses[2]).toMatch(/! couldn't read Claude Code's version/);
  expect(statuses[3]).toMatch(/Claude Code >=2\s+! this machine has 1\.0\.0/);
  expect(statuses[3]).toContain(
    "Fix: Install or update Claude Code, then run barndog sync",
  );
});
