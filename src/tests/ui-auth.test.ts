import { stripVTControlCharacters } from "node:util";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import open from "open";
import { contextSchema } from "@barndog-ai/api-contract";
import { sample } from "./sample.js";
import type { AuthStatus } from "../features/auth/session.js";
import { runLogin, runLogout, showAuthStatus } from "../ui/auth.js";
import {
  login,
  logout,
  authStatus,
  configuredServer,
} from "../features/auth/session.js";
import { readCredentials } from "../features/auth/credentials.js";
import { LoginRequiredError } from "../features/auth/transport.js";
import { CliError } from "../errors.js";
import { promptServer } from "../ui/connection.js";
import { testRuntime } from "./runtime.js";

vi.mock("open", () => ({ default: vi.fn() }));
vi.mock("../features/auth/session.js", () => ({
  login: vi.fn(),
  logout: vi.fn(),
  authStatus: vi.fn(),
  configuredServer: vi.fn(),
}));

vi.mock("../features/auth/credentials.js", () => ({
  readCredentials: vi.fn(),
}));

vi.mock("../ui/connection.js", () => ({ promptServer: vi.fn() }));
const runtime = testRuntime("/unused");
const originalExitCode = process.exitCode;
const context = sample(contextSchema, {
  developer: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Alice",
    slug: "alice",
    role: "organization_admin",
  },
  organization: {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Acme",
    slug: "acme",
  },
});

const status: AuthStatus = { server: "https://example.com", context };
const loginResult = { ...status, expiresAt: "2030-01-01T00:00:00Z" };
const write = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(authStatus).mockResolvedValue(status);
  vi.mocked(login).mockResolvedValue(loginResult);
  vi.mocked(readCredentials).mockResolvedValue({ version: 1, servers: {} });
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

/** Everything written so far, one entry per line, without terminal styling. */
function written(): string[] {
  return write.mock.calls.map(([line]) =>
    stripVTControlCharacters(String(line)),
  );
}

/** Runs `run` as if both stdin and stdout were terminals, then restores them. */
async function withTerminal(run: () => Promise<void>) {
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const set = (
    stream: NodeJS.ReadStream | NodeJS.WriteStream,
    value: boolean,
  ) => Object.defineProperty(stream, "isTTY", { value, configurable: true });

  try {
    set(process.stdin, true);
    set(process.stdout, true);
    await run();
  } finally {
    for (const [stream, descriptor] of [
      [process.stdin, stdin],
      [process.stdout, stdout],
    ] as const) {
      if (descriptor) {
        Object.defineProperty(stream, "isTTY", descriptor);
      } else {
        Reflect.deleteProperty(stream, "isTTY");
      }
    }
  }
}

test("existing session is described without starting device login", async () => {
  await runLogin({ runtime, browser: true, server: status.server }, write);

  expect(written().slice(0, 2)).toEqual([
    "✔ Already signed in as Alice @alice · Acme",
    "  https://example.com",
  ]);

  expect(login).not.toHaveBeenCalled();
});

test.each([true, false])(
  "forced login prints the verification code and URL, then the result (browser=%s)",
  async (browser) => {
    vi.mocked(open).mockResolvedValue(undefined as never);
    vi.mocked(login).mockImplementation(async (options) => {
      await options.verification({
        userCode: "CODE",
        url: "https://example.com/verify",
        browserUrl: "https://example.com/device",
      });

      return loginResult;
    });

    const listeners = process.listenerCount("SIGINT");
    await runLogin(
      { runtime, browser, force: true, server: status.server },
      write,
    );

    const lines = written();
    expect(process.listenerCount("SIGINT")).toBe(listeners);
    expect(lines).toContain("Verification code: CODE");
    expect(lines).toContain(
      "Open https://example.com/verify and confirm this code.",
    );

    expect(lines).toContain("✔ Signed in as Alice @alice · Acme");
    expect(lines).not.toContain("Open the verification URL above to continue.");
    expect(vi.mocked(open).mock.calls).toEqual(
      browser ? [["https://example.com/device"]] : [],
    );

    expect(authStatus).not.toHaveBeenCalled();
  },
);

test("forced login keeps going and tells the user to open the URL when no browser starts", async () => {
  vi.mocked(open).mockRejectedValue(new Error("no browser"));
  vi.mocked(login).mockImplementation(async (options) => {
    await options.verification({
      userCode: "CODE",
      url: "https://example.com/verify",
      browserUrl: "https://example.com/device",
    });

    return loginResult;
  });

  await runLogin(
    { runtime, browser: true, force: true, server: status.server },
    write,
  );

  expect(open).toHaveBeenCalledExactlyOnceWith("https://example.com/device");
  const lines = written();
  expect(lines.indexOf("Open the verification URL above to continue.")).toBe(
    lines.indexOf("Open https://example.com/verify and confirm this code.") + 1,
  );

  expect(lines).toContain("✔ Signed in as Alice @alice · Acme");
});

test.each(["AbortError", "TimeoutError"])(
  "a %s during login says the sign-in expired and points to barndog login",
  async (name) => {
    const cause = Object.assign(new Error("expired"), { name });
    vi.mocked(login).mockRejectedValueOnce(cause);

    const failure = await runLogin(
      { runtime, browser: false, force: true },
      write,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({
      message: "Sign-in expired before it was confirmed.",
      hint: "barndog login",
      cause,
    });
  },
);

test("an unexpected login failure is rethrown unchanged", async () => {
  const failure = new Error("network");
  vi.mocked(login).mockRejectedValueOnce(failure);

  await expect(
    runLogin({ runtime, browser: false, force: true }, write),
  ).rejects.toBe(failure);
});

test("Ctrl+C during login aborts it and says the sign-in was cancelled", async () => {
  let signal: AbortSignal | undefined;
  vi.mocked(login).mockImplementationOnce(async (options) => {
    signal = options.signal;
    const cancel = process.listeners("SIGINT").at(-1);
    if (!cancel) {
      throw new Error("login did not listen for SIGINT");
    }

    cancel("SIGINT");
    throw new Error("network");
  });

  const failure = await runLogin(
    { runtime, browser: false, force: true },
    write,
  ).catch((error: unknown) => error);

  expect(signal?.aborted).toBe(true);
  expect(failure).toBeInstanceOf(CliError);
  expect(failure).toMatchObject({
    message: "Sign-in cancelled.",
    hint: "barndog login",
  });
});

test("login without --server uses the configured server for the session check and sign-in", async () => {
  vi.mocked(configuredServer).mockResolvedValue("https://configured.example");
  vi.mocked(authStatus).mockRejectedValueOnce(new LoginRequiredError());

  await runLogin({ runtime, browser: false }, write);

  expect(authStatus).toHaveBeenCalledExactlyOnceWith(
    runtime,
    "https://configured.example",
  );

  expect(login).toHaveBeenCalledWith(
    expect.objectContaining({ server: "https://configured.example" }),
  );

  expect(promptServer).not.toHaveBeenCalled();
});

test("login prefers --server over the configured server", async () => {
  vi.mocked(configuredServer).mockResolvedValue("https://configured.example");
  vi.mocked(authStatus).mockRejectedValueOnce(new LoginRequiredError());

  await runLogin(
    { runtime, browser: false, server: "https://given.example" },
    write,
  );

  expect(authStatus).toHaveBeenCalledExactlyOnceWith(
    runtime,
    "https://given.example",
  );

  expect(login).toHaveBeenCalledWith(
    expect.objectContaining({ server: "https://given.example" }),
  );

  expect(configuredServer).not.toHaveBeenCalled();
});

test("a server failure while checking the session is not mistaken for being signed out", async () => {
  vi.mocked(configuredServer).mockResolvedValue(status.server);
  const error = new Error("offline");
  vi.mocked(authStatus).mockRejectedValueOnce(error);

  await expect(runLogin({ runtime, browser: false }, write)).rejects.toBe(
    error,
  );

  expect(login).not.toHaveBeenCalled();
});

test("interactive login prompts for a server when none is configured and uses the answer", async () => {
  vi.mocked(configuredServer).mockResolvedValue(undefined);
  vi.mocked(promptServer).mockResolvedValue("https://prompted.example");
  vi.mocked(authStatus).mockRejectedValueOnce(new LoginRequiredError());

  await withTerminal(() => runLogin({ runtime, browser: false }, write));

  expect(promptServer).toHaveBeenCalledOnce();
  expect(authStatus).toHaveBeenCalledExactlyOnceWith(
    runtime,
    "https://prompted.example",
  );

  expect(login).toHaveBeenCalledWith(
    expect.objectContaining({ server: "https://prompted.example" }),
  );
});

test("login without a terminal and without a configured server does not prompt and lets login choose", async () => {
  vi.mocked(configuredServer).mockResolvedValue(undefined);
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    value: false,
    configurable: true,
  });

  try {
    await runLogin({ runtime, browser: false }, write);
  } finally {
    if (stdin) {
      Object.defineProperty(process.stdin, "isTTY", stdin);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
  }

  expect(promptServer).not.toHaveBeenCalled();
  expect(authStatus).not.toHaveBeenCalled();
  expect(login).toHaveBeenCalledWith(
    expect.objectContaining({ server: undefined }),
  );
});

test.each([
  [true, "✔ Signed out of https://example.com."],
  [
    false,
    "! Removed the local credential, but https://example.com did not confirm the session was revoked.",
  ],
])("logout with revoked=%s writes %j", async (revoked, message) => {
  vi.mocked(logout).mockResolvedValue({ revoked, server: status.server });

  await runLogout(write, runtime);

  expect(written()).toEqual([message]);
});

test.each([
  [status.server, "https://example.com"],
  [undefined, undefined],
])(
  "signed-out status in json reports server %s",
  async (server, expectedServer) => {
    vi.mocked(authStatus).mockRejectedValue(new LoginRequiredError());
    vi.mocked(configuredServer).mockResolvedValue(server);

    await showAuthStatus({ write, json: true }, runtime);

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(write.mock.lastCall![0])).toEqual({
      signedIn: false,
      server: expectedServer ?? null,
    });
  },
);

test.each([
  [
    status.server,
    ["✖ Not signed in to https://example.com.", "  Fix: barndog login"],
  ],
  [undefined, ["✖ Not signed in.", "  Fix: barndog init"]],
])(
  "signed-out status in text for server %s tells the user how to fix it",
  async (server, lines) => {
    vi.mocked(authStatus).mockRejectedValue(new LoginRequiredError());
    vi.mocked(configuredServer).mockResolvedValue(server);

    await showAuthStatus({ write }, runtime);

    expect(process.exitCode).toBe(1);
    expect(written()).toEqual(lines);
  },
);

test("signed-out status reports no server when configuration cannot be read", async () => {
  vi.mocked(authStatus).mockRejectedValueOnce(new LoginRequiredError());
  vi.mocked(configuredServer).mockRejectedValueOnce(new Error("bad config"));

  await showAuthStatus({ write, json: true }, runtime);

  expect(JSON.parse(write.mock.lastCall![0])).toEqual({
    signedIn: false,
    server: null,
  });

  expect(process.exitCode).toBe(1);
});

test("status propagates unexpected auth failures without setting a failing exit code", async () => {
  vi.mocked(authStatus).mockRejectedValueOnce(new Error("offline"));
  process.exitCode = undefined;

  await expect(showAuthStatus({ write }, runtime)).rejects.toThrow("offline");
  expect(process.exitCode).toBeUndefined();
});

const credentials = {
  version: 1 as const,
  servers: {
    [status.server]: {
      token: "t".repeat(43),
      expiresAt: "2030-01-01T00:00:00Z",
      context,
    },
  },
};

test("signed-in json status has a null expiry without a stored credential", async () => {
  await showAuthStatus({ write, json: true }, runtime);

  expect(JSON.parse(write.mock.lastCall![0])).toMatchObject({
    signedIn: true,
    server: status.server,
    expiresAt: null,
  });

  expect(process.exitCode).not.toBe(1);
});

test("signed-in json status carries the stored credential's expiry", async () => {
  vi.mocked(readCredentials).mockResolvedValue(credentials);

  await showAuthStatus({ write, json: true }, runtime);

  expect(JSON.parse(write.mock.lastCall![0])).toMatchObject({
    signedIn: true,
    expiresAt: "2030-01-01T00:00:00Z",
  });
});

test("signed-in text status shows identity, role, workspace and the session expiry", async () => {
  vi.mocked(readCredentials).mockResolvedValue(credentials);

  await showAuthStatus({ write }, runtime);

  const lines = written();
  expect(lines[0]).toBe("✔ Signed in");
  expect(lines).toContainEqual(expect.stringMatching(/Name\s+Alice$/));
  expect(lines).toContainEqual(expect.stringMatching(/Handle\s+@alice$/));
  expect(lines).toContainEqual(
    expect.stringMatching(/Organization\s+Acme \(acme\)$/),
  );

  expect(lines).toContainEqual(
    expect.stringMatching(/Role\s+Organization admin$/),
  );

  expect(lines).toContainEqual(
    expect.stringMatching(/Workspace\s+https:\/\/example\.com$/),
  );

  const session = lines.find((line) => line.includes("Session"));
  expect(
    session?.endsWith(
      `expires ${new Date("2030-01-01T00:00:00Z").toLocaleString()}`,
    ),
  ).toBe(true);
});

test("signed-in text status shows the organization once when its name equals its slug", async () => {
  vi.mocked(authStatus).mockResolvedValue({
    ...status,
    context: {
      ...context,
      organization: { ...context.organization, name: "acme", slug: "acme" },
    },
  });

  await showAuthStatus({ write }, runtime);

  const organization = written().find((line) => line.includes("Organization"));
  expect(organization).toMatch(/Organization\s+acme$/);
});

test("signed-in text status omits the session line when no credential is stored", async () => {
  await showAuthStatus({ write }, runtime);

  expect(written().some((line) => line.includes("Session"))).toBe(false);
  expect(written().some((line) => line.includes("Workspace"))).toBe(true);
});
