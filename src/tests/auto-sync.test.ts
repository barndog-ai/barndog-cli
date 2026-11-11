import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveSettings, type SettingsV2 } from "../config/settings.js";
import { updateCredentials } from "../features/auth/credentials.js";
import { autoSync } from "../features/environment/auto-sync.js";
import { synchronize } from "../features/environment/sync.js";

type TestContext = Parameters<NonNullable<Parameters<typeof test>[0]>>[0];

async function connectedHome(t: TestContext, extra: Partial<SettingsV2> = {}) {
  const home = await mkdtemp(join(tmpdir(), "barndog-auto-sync-"));

  t.after(() => rm(home, { recursive: true, force: true }));

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
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

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
      version: 2,
      harnesses: ["claude"],
      skills: [],
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
  assert.equal(syncs(), 1, "the first check always syncs");

  await run();
  assert.equal(backend.requests, 1, "a recent check does not reach the server");
  assert.equal(syncs(), 1);

  await expire();
  await run();
  assert.equal(backend.requests, 2);
  assert.equal(syncs(), 1, "an unchanged revision does not sync");

  await expire();
  backend.revision = "two";
  await run();
  assert.equal(syncs(), 2, "a new revision syncs");
});

test("auto sync retries a change whose sync failed", async (t) => {
  const { backend, expire, run, syncs } = await connectedHome(t);

  await assert.rejects(run(true), /sync failed/);
  assert.equal(syncs(), 1);

  await run();
  assert.equal(syncs(), 1, "a failure still counts toward the limit");

  await expire();
  backend.revision = "one";
  await run();
  assert.equal(syncs(), 2, "the undelivered revision is tried again");
});

test("auto sync keeps the limit when the server can't answer", async (t) => {
  const { backend, expire, run, syncs } = await connectedHome(t);

  await run();
  await expire();
  backend.status = 503;
  await assert.rejects(run());
  assert.equal(syncs(), 1);

  const requests = backend.requests;

  await run();
  assert.equal(backend.requests, requests, "the limit applies while offline");
});

test("auto sync still syncs against a server without the check", async (t) => {
  const { backend, expire, run, syncs } = await connectedHome(t);

  backend.revision = null;
  await run();
  assert.equal(syncs(), 1);

  await run();
  assert.equal(syncs(), 1, "the limit still applies");

  await expire();
  await run();
  assert.equal(syncs(), 2);
});

test("a local folder beside cloud always syncs", async (t) => {
  const { backend, run, syncs } = await connectedHome(t, {
    localWorkspace: { path: "/tmp/barndog-unused", workspaceId: randomUUID() },
  });

  await run();
  await run();
  assert.equal(syncs(), 2);
  assert.equal(backend.requests, 0);
});

test("syncing a cloud workspace registers the session-start sync", async (t) => {
  const { home } = await connectedHome(t);

  await synchronize(undefined, home);

  const settings = JSON.parse(
    await readFile(join(home, ".claude/settings.json"), "utf8"),
  );

  assert.ok(
    settings.hooks.SessionStart.some(
      (entry: { hooks: { command: string }[] }) =>
        entry.hooks[0]!.command.includes("git-workspace/startup.js"),
    ),
  );
});
