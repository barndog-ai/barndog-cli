import { expect, test, type TestContext } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, stat, rm, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  readCredentials,
  updateCredentials,
} from "../features/auth/credentials.js";
import { login, logout, authStatus } from "../features/auth/session.js";
import { normalizeServer, serverFetch } from "../features/auth/transport.js";
import { saveSettings } from "../config/settings.js";
import { createProgram } from "../program.js";

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "barndog-login-"));
  const context = {
    organization: { id: randomUUID(), slug: "acme", name: "Acme" },
    developer: {
      id: randomUUID(),
      slug: "dev",
      name: "Developer",
      role: "developer" as const,
    },
  };
  let pending = true;
  let revoked = false;
  let redirect = false;
  const requests: { path: string; authorization?: string }[] = [];
  const token = "b".repeat(43);
  const server = createServer(async (request, response) => {
    requests.push({
      path: request.url!,
      authorization: request.headers.authorization,
    });
    response.setHeader("Content-Type", "application/json");
    const json = (value: unknown) => response.end(JSON.stringify(value));
    if (redirect) {
      response.writeHead(302, { Location: "https://example.com/stolen" });
      response.end();
      return;
    }
    if (request.url === "/v1/auth/cli/start") {
      response.statusCode = 201;
      json({
        pollingToken: "p".repeat(43),
        userCode: "TEST-CODE",
        verificationUri: "https://example.com/device",
        verificationUriComplete: "https://example.com/device?code=TEST-CODE",
        expiresAt: new Date(Date.now() + 10000).toISOString(),
        interval: 0.001,
      });
      return;
    }
    if (request.url === "/v1/auth/cli/poll") {
      let body = "";
      for await (const chunk of request) body += chunk;
      expect(JSON.parse(body).pollingToken).toBe("p".repeat(43));
      if (pending) {
        pending = false;
        json({ status: "pending", interval: 0.001 });
        return;
      }
      json({
        status: "complete",
        token,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        context,
      });
      return;
    }
    expect(request.headers.authorization).toBe(`Bearer ${token}`);
    if (request.url === "/v1/auth/cli/session") {
      revoked = true;
      response.writeHead(204);
      response.end();
      return;
    }
    if (revoked) {
      response.writeHead(401);
      json({
        statusCode: 401,
        code: "UNAUTHORIZED",
        message: "LOGIN_REQUIRED",
      });
      return;
    }
    json(context);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server");
  const origin = `http://127.0.0.1:${address.port}`;
  t.onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });
  return {
    home,
    context,
    token,
    origin,
    requests,
    redirect: () => {
      redirect = true;
    },
    revoked: () => revoked,
  };
}

test("browser verification, pending polling, private credential storage, status and logout", async (t) => {
  const f = await fixture(t);
  let verification;
  const result = await login({
    server: f.origin,
    home: f.home,
    verification: async (value) => {
      verification = value;
    },
  });
  expect(result.context.developer.id).toBe(f.context.developer.id);
  expect(verification).toStrictEqual({
    userCode: "TEST-CODE",
    url: "https://example.com/device",
    browserUrl: "https://example.com/device?code=TEST-CODE",
  });
  const path = join(f.home, ".barndog", "credentials.json");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(f.home, ".barndog"))).mode & 0o777).toBe(0o700);
  expect((await authStatus(f.home)).context.developer.id).toBe(
    f.context.developer.id,
  );
  expect(
    f.requests
      .filter((request) => /start|poll/.test(request.path))
      .every((request) => !request.authorization),
  ).toBeTruthy();
  expect((await logout(f.home)).revoked).toBe(true);
  expect(f.revoked()).toBe(true);
  expect((await readCredentials(f.home)).servers[f.origin]).toBe(undefined);
  expect(await readFile(path, "utf8")).not.toContain(f.token);
  await expect(authStatus(f.home)).rejects.toThrow(/barndog login/);
});

test("API selections prevent account switches without changing saved credentials", async (t) => {
  const f = await fixture(t);
  await updateCredentials(f.home, (value) => {
    value.servers[f.origin] = {
      token: "a".repeat(43),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      context: f.context,
    };
  });
  await saveSettings(
    {
      version: 2,
      harnesses: [],
      connection: {
        server: f.origin,
        organizationId: f.context.organization.id,
        developerId: randomUUID(),
      },
      skills: [{ kind: "api", id: randomUUID(), enabled: true }],
    },
    f.home,
  );
  const before = await readCredentials(f.home);
  await expect(
    login({ server: f.origin, home: f.home, verification: async () => {} }),
  ).rejects.toThrow(/Remove API selections/);
  expect(await readCredentials(f.home)).toStrictEqual(before);
  expect(f.revoked()).toBe(true);
});

test("authenticated transport rejects insecure origins, redirects, cross-server requests and missing credentials", async (t) => {
  const f = await fixture(t);
  expect(() => normalizeServer("http://example.com")).toThrow(/HTTPS/);
  expect(() => normalizeServer("https://example.com/path")).toThrow(/origin/);
  for (const origin of [
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
    "https://example.com",
  ])
    expect(normalizeServer(origin)).toBe(origin);
  await expect(
    serverFetch(f.origin, f.home)(`${f.origin}/v1/context`),
  ).rejects.toThrow(/barndog login/);
  await login({ server: f.origin, home: f.home, verification: async () => {} });
  await expect(
    serverFetch(f.origin, f.home)("https://example.com/v1/context"),
  ).rejects.toThrow(/another server/);
  f.redirect();
  await expect(
    serverFetch(f.origin, f.home)(`${f.origin}/v1/context`),
  ).rejects.toThrow();
  await chmod(join(f.home, ".barndog", "credentials.json"), 0o644);
  await expect(readCredentials(f.home)).rejects.toThrow(/only to its owner/);
});

test("cancelling login never creates a credential", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  await expect(
    login({
      server: f.origin,
      home: f.home,
      signal: controller.signal,
      verification: async () => {
        controller.abort();
      },
    }),
  ).rejects.toThrow();
  expect((await readCredentials(f.home)).servers).toStrictEqual({});
});

test("auth command parsing delegates flags and never renders credentials", async () => {
  const calls: unknown[] = [];
  const program = createProgram({
    login: async (options) => {
      calls.push(options);
    },
    logout: async () => {
      calls.push("logout");
    },
    authStatus: async () => {
      calls.push("status");
    },
    write: () => {},
  });
  await program.parseAsync(
    ["login", "--server", "https://example.com", "--no-browser"],
    { from: "user" },
  );
  await program.parseAsync(["logout"], { from: "user" });
  await program.parseAsync(["auth", "status"], { from: "user" });
  expect(calls).toStrictEqual([
    { server: "https://example.com", browser: false },
    "logout",
    "status",
  ]);
});
