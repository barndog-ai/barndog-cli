import { test } from "node:test";
import assert from "node:assert/strict";
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

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
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
      assert.equal(JSON.parse(body).pollingToken, "p".repeat(43));
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
    assert.equal(request.headers.authorization, `Bearer ${token}`);
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
  t.after(async () => {
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
  assert.equal(result.context.developer.id, f.context.developer.id);
  assert.deepEqual(verification, {
    userCode: "TEST-CODE",
    url: "https://example.com/device",
    browserUrl: "https://example.com/device?code=TEST-CODE",
  });
  const path = join(f.home, ".barndog", "credentials.json");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.home, ".barndog"))).mode & 0o777, 0o700);
  assert.equal(
    (await authStatus(f.home)).context.developer.id,
    f.context.developer.id,
  );
  assert.ok(
    f.requests
      .filter((request) => /start|poll/.test(request.path))
      .every((request) => !request.authorization),
  );
  assert.equal((await logout(f.home)).revoked, true);
  assert.equal(f.revoked(), true);
  assert.equal((await readCredentials(f.home)).servers[f.origin], undefined);
  assert.ok(!(await readFile(path, "utf8")).includes(f.token));
  await assert.rejects(authStatus(f.home), /barndog login/);
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
  await assert.rejects(
    login({ server: f.origin, home: f.home, verification: async () => {} }),
    /Remove API selections/,
  );
  assert.deepEqual(await readCredentials(f.home), before);
  assert.equal(f.revoked(), true);
});

test("authenticated transport rejects insecure origins, redirects, cross-server requests and missing credentials", async (t) => {
  const f = await fixture(t);
  assert.throws(() => normalizeServer("http://example.com"), /HTTPS/);
  assert.throws(() => normalizeServer("https://example.com/path"), /origin/);
  for (const origin of [
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
    "https://example.com",
  ])
    assert.equal(normalizeServer(origin), origin);
  await assert.rejects(
    serverFetch(f.origin, f.home)(`${f.origin}/v1/context`),
    /barndog login/,
  );
  await login({ server: f.origin, home: f.home, verification: async () => {} });
  await assert.rejects(
    serverFetch(f.origin, f.home)("https://example.com/v1/context"),
    /another server/,
  );
  f.redirect();
  await assert.rejects(serverFetch(f.origin, f.home)(`${f.origin}/v1/context`));
  await chmod(join(f.home, ".barndog", "credentials.json"), 0o644);
  await assert.rejects(readCredentials(f.home), /only to its owner/);
});

test("cancelling login never creates a credential", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(
    login({
      server: f.origin,
      home: f.home,
      signal: controller.signal,
      verification: async () => {
        controller.abort();
      },
    }),
  );
  assert.deepEqual((await readCredentials(f.home)).servers, {});
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
  assert.deepEqual(calls, [
    { server: "https://example.com", browser: false },
    "logout",
    "status",
  ]);
});
