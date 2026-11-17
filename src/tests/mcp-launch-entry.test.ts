import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import crossSpawn from "cross-spawn";
import { stopProcessTree } from "../platform.js";

vi.mock("cross-spawn", () => ({ default: vi.fn() }));
vi.mock("../platform.js", async (original) => ({
  ...(await original<typeof import("../platform.js")>()),
  stopProcessTree: vi.fn(),
}));

const argv = process.argv;
const exitCode = process.exitCode;
const signals = {
  SIGINT: process.listeners("SIGINT"),
  SIGTERM: process.listeners("SIGTERM"),
};

afterEach(() => {
  vi.mocked(stopProcessTree).mockReset();
  vi.mocked(crossSpawn).mockReset();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const listener of process.listeners(signal)) {
      if (!signals[signal].includes(listener)) {
        process.removeListener(signal, listener);
      }
    }
  }

  process.argv = argv;
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const definition = {
  transport: "stdio",
  command: "node",
  args: ["server.js"],
  environment: { TOKEN: { secretRef: "BARNDOG_TEST_SECRET" } },
  authentication: "environment",
  description: "Fixture",
};

const SECRET_NOT_SET =
  "BARNDOG_TEST_SECRET isn't set in your environment. Set it, then restart your coding tool.";

/** Starts the launcher the way a harness does: the definition is the one base64url argument. */
async function startLauncher(configuration: string | undefined) {
  vi.resetModules();
  process.argv = [
    process.execPath,
    "launch",
    ...(configuration === undefined
      ? []
      : [Buffer.from(configuration).toString("base64url")]),
  ];

  await import("../entry/mcp-launch.js");
}

/** Starts the launcher with a working definition and returns its fake child process. */
async function startServer() {
  vi.stubEnv("BARNDOG_TEST_SECRET", "local-value");
  const child = Object.assign(new EventEmitter(), { pid: 12345 });
  vi.mocked(crossSpawn).mockReturnValue(child as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const before = {
    SIGINT: process.listeners("SIGINT"),
    SIGTERM: process.listeners("SIGTERM"),
  };

  await startLauncher(JSON.stringify(definition));

  /** The handler the launcher registered for `signal`. */
  const handler = (signal: "SIGINT" | "SIGTERM") => {
    const added = process
      .listeners(signal)
      .find((listener) => !before[signal].includes(listener));

    if (!added) {
      throw new Error(`The launcher registered no ${signal} handler`);
    }

    return added;
  };

  return { child, handler };
}

test("stdio launcher starts the configured command with the secret under its variable name", async () => {
  vi.stubEnv("BARNDOG_TEST_SECRET", "local-value");
  vi.mocked(crossSpawn).mockReturnValue(
    Object.assign(new EventEmitter(), { pid: 1 }) as never,
  );

  await startLauncher(JSON.stringify(definition));

  expect(crossSpawn).toHaveBeenCalledExactlyOnceWith("node", ["server.js"], {
    env: expect.objectContaining({
      TOKEN: "local-value",
      BARNDOG_TEST_SECRET: "local-value",
    }),
    stdio: "inherit",
    detached: process.platform !== "win32",
    cwd: process.cwd(),
    windowsHide: true,
  });
});

test.each([
  [0, 0],
  [2, 2],
  [null, 1],
])(
  "stdio launcher exits with the child's code (%s -> %s)",
  async (code, exitCode) => {
    const { child } = await startServer();

    child.emit("exit", code);

    expect(process.exitCode).toBe(exitCode);
    expect(console.error).not.toHaveBeenCalled();
  },
);

test("stdio launcher reports a child that cannot start and fails", async () => {
  const { child } = await startServer();

  child.emit("error", new Error("spawn node ENOENT"));

  expect(console.error).toHaveBeenCalledExactlyOnceWith(
    "Unable to start the configured MCP command",
  );

  expect(process.exitCode).toBe(1);
});

test.each(["SIGINT", "SIGTERM"] as const)(
  "%s asks the MCP process tree to stop at once, then forces it after two seconds",
  async (signal) => {
    vi.useFakeTimers();
    const { child, handler } = await startServer();
    const runtime = expect.objectContaining({ platform: process.platform });

    handler(signal)(signal);

    expect(stopProcessTree).toHaveBeenCalledExactlyOnceWith(
      child,
      runtime,
      signal,
    );

    await vi.advanceTimersByTimeAsync(1999);
    expect(stopProcessTree).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(stopProcessTree).toHaveBeenCalledTimes(2);
    // The second call has no signal, so it uses the forceful default.
    expect(vi.mocked(stopProcessTree).mock.calls[1]).toEqual([child, runtime]);
  },
);

test("a signal before the child has a pid does nothing", async () => {
  vi.useFakeTimers();
  const { child, handler } = await startServer();
  child.pid = 0;

  handler("SIGTERM")("SIGTERM");
  await vi.advanceTimersByTimeAsync(5000);

  expect(stopProcessTree).not.toHaveBeenCalled();
});

test("a child that already exited is not forced after the grace period", async () => {
  vi.useFakeTimers();
  const { handler } = await startServer();
  vi.mocked(stopProcessTree).mockImplementation(() => {
    throw new Error("exited");
  });

  expect(() => handler("SIGTERM")("SIGTERM")).not.toThrow();
  await vi.advanceTimersByTimeAsync(5000);

  expect(stopProcessTree).toHaveBeenCalledOnce();
});

test("a failure while forcing the stop after the grace period is ignored", async () => {
  vi.useFakeTimers();
  const { handler } = await startServer();
  vi.mocked(stopProcessTree)
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw new Error("exited");
    });

  handler("SIGTERM")("SIGTERM");

  await expect(vi.advanceTimersByTimeAsync(2000)).resolves.not.toThrow();
  expect(stopProcessTree).toHaveBeenCalledTimes(2);
});

/** What `JSON.parse` says about text that is not JSON, which the launcher prints as is. */
function jsonParseMessage(text: string) {
  try {
    JSON.parse(text);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("Expected the text not to parse");
}

const rejections: {
  name: string;
  configuration: string | undefined;
  message: string;
  secret?: string;
}[] = [
  {
    name: "no definition argument",
    configuration: undefined,
    message: jsonParseMessage(""),
  },
  {
    name: "a definition that is not JSON",
    configuration: "not-json",
    message: jsonParseMessage("not-json"),
  },
  {
    name: "an HTTP definition",
    configuration: JSON.stringify({
      transport: "http",
      url: "https://example.test/mcp",
      headers: {},
      authentication: "none",
      description: "HTTP",
    }),
    message: "A stdio configuration is required",
  },
  {
    name: "a secret that is set but empty",
    configuration: JSON.stringify(definition),
    secret: "",
    message: SECRET_NOT_SET,
  },
];

test.each(rejections)(
  "stdio launcher refuses $name without starting anything",
  async ({ configuration, message, secret }) => {
    vi.stubEnv("BARNDOG_TEST_SECRET", secret ?? "");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await startLauncher(configuration);

    expect(error).toHaveBeenCalledExactlyOnceWith(message);
    expect(process.exitCode).toBe(1);
    expect(crossSpawn).not.toHaveBeenCalled();
  },
);

test("stdio launcher refuses a secret that is not in the environment at all", async () => {
  vi.stubEnv("BARNDOG_TEST_SECRET", undefined);
  delete process.env.BARNDOG_TEST_SECRET;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  await startLauncher(JSON.stringify(definition));

  expect(error).toHaveBeenCalledExactlyOnceWith(SECRET_NOT_SET);
  expect(process.exitCode).toBe(1);
  expect(crossSpawn).not.toHaveBeenCalled();
});
