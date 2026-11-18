import { EventEmitter } from "node:events";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ChildProcess } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import crossSpawn from "cross-spawn";
import * as contract from "@barndog-ai/api-contract";
import { cloud } from "./cloud.js";
import { sample } from "./sample.js";
import { CliError } from "../errors.js";
import { authenticateMcp } from "../features/mcps/index.js";
import type { Harness } from "../harnesses/types.js";
import { renderError } from "../ui/output.js";
import { testRuntime } from "./runtime.js";

vi.mock("cross-spawn", () => ({ default: vi.fn() }));
afterEach(() => vi.mocked(crossSpawn).mockReset());

type TestContext = import("vitest").TestContext;

/** The command each harness runs to sign in, followed by the MCP's name. */
const loginCommands = {
  claude: ["claude", "mcp", "login"],
  codex: ["codex", "mcp", "login"],
} as const;

/** A Cloud workspace whose `release-notes` MCP uses the harness's own OAuth sign-in. */
async function oauthWorkspace(t: TestContext, harness: Harness) {
  const server = await cloud(t, { harnesses: [harness] });
  server.respond(
    "GET",
    "/v1/mcps/([^/]+)",
    (_: Request, match: RegExpMatchArray) => {
      const mcp = sample(contract.mcpSchema, { id: match[1] });

      return {
        ...mcp,
        version: {
          ...mcp.version,
          definition: {
            transport: "http",
            url: "https://mcp.example.test",
            headers: {},
            description: "Example",
            authentication: "native-oauth",
          },
        },
      };
    },
  );

  return server;
}

/** Makes the next spawned login process finish the way a real one would. */
function loginProcess(finish: (child: EventEmitter) => void) {
  const child = new EventEmitter();
  vi.mocked(crossSpawn).mockImplementationOnce(() => {
    queueMicrotask(() => finish(child));

    return child as ChildProcess;
  });
}

for (const harness of ["claude", "codex"] as const) {
  const command = loginCommands[harness];
  const login = command.join(" ");

  test(`${harness} sign-in runs its login command for the MCP in the neutral directory and reports success`, async (t) => {
    const server = await oauthWorkspace(t, harness);
    await server.run(["mcp", "install", "release-notes", "--origin", "org"]);
    loginProcess((child) => child.emit("exit", 0));
    const runtime = testRuntime(server.home);

    const result = await authenticateMcp(
      "release-notes",
      "org",
      harness,
      runtime,
    );

    expect(result).toEqual({
      message: `${harness} authentication completed. Credentials remain in native storage.`,
    });

    expect(crossSpawn).toHaveBeenCalledExactlyOnceWith(
      command[0],
      [...command.slice(1), "release-notes"],
      {
        cwd: join(server.home, ".barndog", "native-auth"),
        stdio: "inherit",
        env: { ...runtime.env },
      },
    );
  });

  test(`${harness} sign-in after a rename names the server as installed, not as published`, async (t) => {
    const server = await oauthWorkspace(t, harness);
    await server.run(["mcp", "install", "release-notes", "--origin", "org"]);
    await server.run([
      "mcp",
      "rename",
      "release-notes",
      "--origin",
      "org",
      "--as",
      "notes",
    ]);

    loginProcess((child) => child.emit("exit", 0));

    await authenticateMcp(
      "release-notes",
      "org",
      harness,
      testRuntime(server.home),
    );

    expect(vi.mocked(crossSpawn).mock.calls[0]?.[1]).toEqual([
      ...command.slice(1),
      "notes",
    ]);
  });

  test(`${harness} login that exits with code 2 tells the user to rerun it`, async (t) => {
    const server = await oauthWorkspace(t, harness);
    await server.run(["mcp", "install", "release-notes", "--origin", "org"]);
    loginProcess((child) => child.emit("exit", 2));

    const failure = await authenticateMcp(
      "release-notes",
      "org",
      harness,
      testRuntime(server.home),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({
      message: `${login} exited with code 2, so sign-in didn't finish.`,
      hint: `${login} release-notes`,
    });
  });

  test(`${harness} login killed by a signal is reported as exit code 1`, async (t) => {
    const server = await oauthWorkspace(t, harness);
    await server.run(["mcp", "install", "release-notes", "--origin", "org"]);
    loginProcess((child) => child.emit("exit", null));

    const failure = await authenticateMcp(
      "release-notes",
      "org",
      harness,
      testRuntime(server.home),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({
      message: `${login} exited with code 1, so sign-in didn't finish.`,
      hint: `${login} release-notes`,
    });
  });

  test(`${harness} sign-in without the ${harness} program installed says it can't find it`, async (t) => {
    const server = await oauthWorkspace(t, harness);
    await server.run(["mcp", "install", "release-notes", "--origin", "org"]);
    const missing = Object.assign(new Error(`spawn ${command[0]} ENOENT`), {
      code: "ENOENT",
      errno: -2,
      syscall: `spawn ${command[0]}`,
      path: command[0],
    });

    loginProcess((child) => child.emit("error", missing));

    const failure = await authenticateMcp(
      "release-notes",
      "org",
      harness,
      testRuntime(server.home),
    ).catch((error: unknown) => error);

    expect(failure).toBe(missing);
    expect(stripVTControlCharacters(renderError(failure))).toBe(
      `✖ Can't find ${command[0]}.`,
    );
  });

  test(`${harness} sign-in for an MCP that is not installed asks to install it first and starts nothing`, async (t) => {
    const server = await oauthWorkspace(t, harness);

    const failure = await authenticateMcp(
      "release-notes",
      "org",
      harness,
      testRuntime(server.home),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({
      message: `release-notes isn't installed and enabled for ${harness}.`,
      hint: "barndog mcp install release-notes",
    });

    expect(crossSpawn).not.toHaveBeenCalled();
  });
}
