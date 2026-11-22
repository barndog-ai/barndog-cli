import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import type { McpDefinition } from "@barndog-ai/api-contract";
import { adapters } from "../harnesses/registry.js";
import {
  withRenamedVariables,
  type RenamedVariable,
} from "../harnesses/renamed-variables.js";

/** A stand-in MCP server: prints what it received, then exits with `EXIT_CODE`. */
const SERVER = `
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const env = (name) => process.env[name] ?? null;
  process.stdout.write(JSON.stringify({
    argv: process.argv.slice(2),
    token: env("GITHUB_PERSONAL_ACCESS_TOKEN"),
    a: env("A"),
    b: env("B"),
    input,
  }));
  process.exit(Number(process.env.EXIT_CODE ?? 0));
});
`;

/** Arguments a shell would read as syntax if they ever became script text. */
const awkward = [
  "a b",
  "$HOME",
  "it's",
  "x;y && z",
  'say "hi"',
  "",
  "-c",
  "back\\slash\\",
  "spaced end\\",
  'quote at end\\"',
  "tab\there",
  "%PATH%",
  "`tick` $(whoami)",
];

/** Lines an MCP client sends over stdin, which must reach the server untouched. */
const messages =
  '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","method":"ping"}\n';

async function run(
  renamed: RenamedVariable[],
  args: string[],
  env: Record<string, string>,
) {
  const folder = await mkdtemp(join(tmpdir(), "barndog-renamed-"));
  try {
    const script = join(folder, "server.js");
    await writeFile(script, SERVER);

    const wrapper = withRenamedVariables(
      { command: process.execPath, args: [script, ...args] },
      renamed,
      process.platform,
    );

    const environment = { ...process.env };
    for (const name of ["GITHUB_PERSONAL_ACCESS_TOKEN", "A", "B"]) {
      delete environment[name];
    }

    const result = spawnSync(wrapper.command, wrapper.args, {
      input: messages,
      encoding: "utf8",
      env: { ...environment, ...env },
    });

    return {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
      received: result.stdout
        ? (JSON.parse(result.stdout) as Record<string, unknown>)
        : undefined,
    };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test("the wrapper gives the server the renamed variable, its exact arguments and stdin, and its exit code", async () => {
  const result = await run(
    [{ name: "GITHUB_PERSONAL_ACCESS_TOKEN", from: "GITHUB_TOKEN" }],
    awkward,
    { GITHUB_TOKEN: "ghp_secret", EXIT_CODE: "7" },
  );

  expect(result.stderr).toBe("");
  expect(result.status).toBe(7);
  expect(result.received).toStrictEqual({
    argv: awkward,
    token: "ghp_secret",
    a: null,
    b: null,
    input: messages,
  });
});

test("the wrapper reads every value before setting any, so a swap works", async () => {
  const result = await run(
    [
      { name: "A", from: "B" },
      { name: "B", from: "A" },
      { name: "GITHUB_PERSONAL_ACCESS_TOKEN", from: "A" },
    ],
    [],
    { A: "first", B: "second" },
  );

  expect(result.status).toBe(0);
  expect(result.received).toMatchObject({
    a: "second",
    b: "first",
    token: "first",
  });
});

test("the wrapper stops before starting the server when a variable is not set", async () => {
  const result = await run(
    [{ name: "GITHUB_PERSONAL_ACCESS_TOKEN", from: "GITHUB_TOKEN" }],
    [],
    { GITHUB_TOKEN: "" },
  );

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("GITHUB_TOKEN is not set");
  expect(result.stdout).toBe("");
});

test.skipIf(process.platform === "win32")(
  "a server command that sets the same variable itself wins, as with any tool's env",
  async () => {
    const folder = await mkdtemp(join(tmpdir(), "barndog-renamed-"));
    try {
      const script = join(folder, "server.js");
      await writeFile(script, SERVER);

      const wrapper = withRenamedVariables(
        {
          command: "/bin/sh",
          args: [
            "-c",
            'GITHUB_PERSONAL_ACCESS_TOKEN=own exec "$0" "$@"',
            process.execPath,
            script,
          ],
        },
        [{ name: "GITHUB_PERSONAL_ACCESS_TOKEN", from: "GITHUB_TOKEN" }],
        process.platform,
      );

      const result = spawnSync(wrapper.command, wrapper.args, {
        input: "",
        encoding: "utf8",
        env: { ...process.env, GITHUB_TOKEN: "ghp_secret" },
      });

      expect(JSON.parse(result.stdout)).toMatchObject({ token: "own" });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  },
);

const mixed: McpDefinition = {
  description: "GitHub",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  environment: {
    GITHUB_PERSONAL_ACCESS_TOKEN: { secretRef: "GITHUB_TOKEN" },
    GITHUB_HOST: { secretRef: "GITHUB_HOST" },
    API_KEY: { secretRef: "SAVED_KEY" },
    OTHER_TOKEN: { secretRef: "GITHUB_TOKEN" },
  },
  authentication: "environment",
};

test("Codex wraps only renamed variables; same-named ones are forwarded and kept ones written", () => {
  const entry = adapters.codex.mcp.server(
    mixed,
    { SAVED_KEY: "sk-saved" },
    "linux",
  );

  expect(entry).toStrictEqual({
    command: "/bin/sh",
    args: [
      "-c",
      ': "${GITHUB_TOKEN:?GITHUB_TOKEN is not set}"; exec /usr/bin/env ' +
        `'GITHUB_PERSONAL_ACCESS_TOKEN='"$GITHUB_TOKEN" 'OTHER_TOKEN='"$GITHUB_TOKEN" "$0" "$@"`,
      "npx",
      "-y",
      "@modelcontextprotocol/server-github",
    ],
    env: { API_KEY: "sk-saved" },
    env_vars: ["GITHUB_TOKEN", "GITHUB_HOST"],
  });
});

test("Codex on Windows starts renamed variables through Windows PowerShell", () => {
  const entry = adapters.codex.mcp.server(mixed, {}, "win32");

  expect(entry.command).toBe("powershell.exe");

  const args = entry.args as string[];
  const script = Buffer.from(String(args.at(-1)), "base64").toString("utf16le");

  expect(script).toContain(
    "[Environment]::SetEnvironmentVariable('GITHUB_PERSONAL_ACCESS_TOKEN', $v0)",
  );

  expect(script).toContain(
    "& 'npx' '-y' '@modelcontextprotocol/server-github'",
  );

  expect(entry.env_vars).toStrictEqual([
    "GITHUB_TOKEN",
    "GITHUB_HOST",
    "SAVED_KEY",
  ]);
});

test("Codex starts a server without renamed variables directly", () => {
  const entry = adapters.codex.mcp.server(
    {
      ...mixed,
      environment: { GITHUB_HOST: { secretRef: "GITHUB_HOST" } },
    },
    {},
    "linux",
  );

  expect(entry).toStrictEqual({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env_vars: ["GITHUB_HOST"],
  });
});
