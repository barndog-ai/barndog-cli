import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveSettings, type Settings } from "../config/settings.js";
import { updateCredentials } from "../features/auth/credentials.js";
import { autoSync } from "../features/environment/auto-sync.js";
import { synchronize } from "../features/environment/sync.js";

type TestContext = import("vitest").TestContext;

async function connectedHome(t: TestContext, extra: Partial<Settings> = {}) {
  const home = await mkdtemp(join(tmpdir(), "barndog-auto-sync-"));

  t.onTestFinished(() => rm(home, { recursive: true, force: true }));

  const organizationId = randomUUID();
  const developerId = randomUUID();
  const context = {
    organization: { id: organizationId, name: "Acme", slug: "acme" },
    developer: {
      id: developerId,
      name: "Alice",
      slug: "alice",
      role: "developer" as const,
    },
  };
  const backend = {
    revision: "one" as string | null,
    status: 200,
    requests: 0,
  };
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");

    const send = (value: unknown) => res.end(JSON.stringify(value));

    if (req.url === "/v1/context") return send(context);

    if (req.url === "/v1/environment/catalog")
      return send({ assets: [], distributions: [] });

    if (req.url === "/v1/environment/catalog/revision") {
      backend.requests += 1;

      if (backend.status !== 200 || backend.revision === null) {
        res.statusCode = backend.revision === null ? 404 : backend.status;

        return send({ code: "UNAVAILABLE", message: "unavailable" });
      }

      return send({ revision: backend.revision });
    }

    res.statusCode = 404;
    send({ code: "NOT_FOUND", message: req.url });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.onTestFinished(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );

  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  await updateCredentials(home, (credentials) => {
    credentials.selectedServer = url;
    credentials.servers[url] = {
      token: "t".repeat(43),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      context,
    };
  });

  await saveSettings(
    {
      harnesses: ["claude"],
      knowledge: false,
      connection: { server: url, organizationId, developerId },
      environment: {
        subscriptions: [],
        individualAssetIds: [],
        excludedAssetIds: [],
        disabledAssetIds: [],
      },
      ...extra,
    },
    home,
  );

  /** Moves the last check past the five-minute limit. */
  const expire = async () => {
    const path = join(home, ".barndog/cloud-check.json");
    const check = JSON.parse(await readFile(path, "utf8"));

    check.checkedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    await writeFile(path, JSON.stringify(check));
  };
  let syncs = 0;
  const run = (fail = false) =>
    autoSync(async () => {
      syncs += 1;

      if (fail) throw new Error("sync failed");
    }, home);

  return { home, backend, expire, run, syncs: () => syncs };
}

test("auto sync skips a cloud workspace until its catalog changes", async (t) => {
  const { backend, expire, run, syncs } = await connectedHome(t);

  await run();
  expect(syncs(), "the first check always syncs").toBe(1);

  await run();
  expect(backend.requests, "a recent check does not reach the server").toBe(1);
  expect(syncs()).toBe(1);

  await expire();
  await run();
  expect(backend.requests).toBe(2);
  expect(syncs(), "an unchanged revision does not sync").toBe(1);

  await expire();
  backend.revision = "two";
  await run();
  expect(syncs(), "a new revision syncs").toBe(2);
});

test("auto sync retries a change whose sync failed", async (t) => {
  const { backend, expire, run, syncs } = await connectedHome(t);

  await expect(run(true)).rejects.toThrow(/sync failed/);
  expect(syncs()).toBe(1);

  await run();
  expect(syncs(), "a failure still counts toward the limit").toBe(1);

  await expire();
  backend.revision = "one";
  await run();
  expect(syncs(), "the undelivered revision is tried again").toBe(2);
});

test("auto sync keeps the limit when the server can't answer", async (t) => {
  const { backend, expire, run, syncs } = await connectedHome(t);

  await run();
  await expire();
  backend.status = 503;
  await expect(run()).rejects.toThrow();
  expect(syncs()).toBe(1);

  const requests = backend.requests;

  await run();
  expect(backend.requests, "the limit applies while offline").toBe(requests);
});

test("auto sync still syncs against a server without the check", async (t) => {
  const { backend, expire, run, syncs } = await connectedHome(t);

  backend.revision = null;
  await run();
  expect(syncs()).toBe(1);

  await run();
  expect(syncs(), "the limit still applies").toBe(1);

  await expire();
  await run();
  expect(syncs()).toBe(2);
});

test("a local folder beside cloud always syncs", async (t) => {
  const { backend, run, syncs } = await connectedHome(t, {
    localWorkspace: { path: "/tmp/barndog-unused", workspaceId: randomUUID() },
  });

  await run();
  await run();
  expect(syncs()).toBe(2);
  expect(backend.requests).toBe(0);
});

test("syncing a cloud workspace registers the session-start sync", async (t) => {
  const { home } = await connectedHome(t);

  await synchronize(undefined, home);

  const settings = JSON.parse(
    await readFile(join(home, ".claude/settings.json"), "utf8"),
  );

  expect(
    settings.hooks.SessionStart.some(
      (entry: { hooks: { command: string }[] }) =>
        entry.hooks[0]!.command.includes("git-workspace/startup.js"),
    ),
  ).toBeTruthy();
});
