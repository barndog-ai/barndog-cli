import { assert, expect, test } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { environmentOperation } from "../features/environment/operations.js";
import { runSetup } from "../ui/onboarding.js";
import {
  readSettings,
  saveSettings,
  settingsPath,
} from "../config/settings.js";
import {
  readCredentials,
  updateCredentials,
} from "../features/auth/credentials.js";

for (const state of ["missing", "expired", "valid", "revoked"] as const) {
  test(`connected first-run setup handles a ${state} session without a default server`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "barndog-connected-setup-"));
    t.onTestFinished(() => rm(home, { recursive: true, force: true }));
    const context = {
      organization: { id: randomUUID(), name: "Acme", slug: "acme" },
      developer: {
        id: randomUUID(),
        name: "Alice",
        slug: "alice",
        role: "developer",
      },
    };
    const mcpId = randomUUID();
    const versionId = randomUUID();
    const originScope = {
      type: "org",
      id: context.organization.id,
      slug: "acme",
    };
    const mcp = {
      id: mcpId,
      organizationId: context.organization.id,
      name: "docs",
      origin: originScope,
      createdBy: context.developer.id,
      createdAt: new Date().toISOString(),
      distributions: [],
      version: {
        id: versionId,
        mcpId,
        number: 1,
        publishedBy: context.developer.id,
        publishedAt: new Date().toISOString(),
        definition: {
          transport: "http",
          url: "https://example.com/mcp",
          description: "Shared docs",
          authentication: "none",
          headers: {},
        },
      },
    };
    let signedIn = state === "valid";
    let logins = 0;
    let failCatalog = false;
    const token = "s".repeat(43);
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      const send = (value: unknown) => res.end(JSON.stringify(value));
      if (req.url === "/v1/auth/cli/start") {
        logins++;
        res.statusCode = 201;
        send({
          pollingToken: "p".repeat(43),
          userCode: "TEST-CODE",
          verificationUri: "https://example.com/device",
          verificationUriComplete: "https://example.com/device?code=TEST-CODE",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          interval: 0.001,
        });
        return;
      }
      if (req.url === "/v1/auth/cli/poll") {
        signedIn = true;
        send({
          status: "complete",
          token,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          context,
        });
        return;
      }
      expect(req.headers.authorization).toBe(`Bearer ${token}`);
      if (!signedIn) {
        res.statusCode = 401;
        send({ message: "LOGIN_REQUIRED" });
        return;
      }
      const data: Record<string, unknown> = {
        "/v1/context": context,
        "/v1/scopes": [
          { type: "org", ...context.organization, canPublish: false },
        ],
        "/v1/environment/catalog": {
          assets: [
            {
              id: mcpId,
              kind: "mcp",
              name: "docs",
              origin: originScope,
              publishedVersion: versionId,
            },
          ],
          distributions: [
            {
              scope: { type: "org", id: context.organization.id },
              assets: [{ assetId: mcpId, mode: "recommended" }],
            },
          ],
        },
        [`/v1/mcps/${mcpId}`]: mcp,
        "/v1/repositories": [],
        "/v1/teams": [],
      };
      if (failCatalog && req.url === "/v1/environment/catalog") {
        res.statusCode = 503;
        send({ message: "Unavailable" });
        return;
      }
      expect(req.url! in data, req.url).toBeTruthy();
      send(data[req.url!]);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.onTestFinished(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (state !== "missing")
      await updateCredentials(home, (credentials) => {
        credentials.selectedServer = origin;
        credentials.servers[origin] = {
          token,
          context: {
            ...context,
            developer: { ...context.developer, role: "developer" },
          },
          expiresAt: new Date(
            Date.now() + (state === "expired" ? -1000 : 60000),
          ).toISOString(),
        };
      });
    const output: string[] = [];
    let connections = 0;
    const options = {
      home,
      cwd: home,
      interactive: true,
      browser: false,
      detected: [],
      write: (line: string) => output.push(line),
      chooseConnection: async () => {
        connections++;
        return { kind: "cloud" as const, server: origin };
      },
      choose: async () => ["codex" as const],
      chooseEnvironment: async (
        choices: import("../features/onboarding/environment.js").EnvironmentChoices,
      ) => {
        expect(choices.previous.subscriptions).toStrictEqual([]);
        return { ...choices.previous, individualAssetIds: [mcpId] };
      },
      confirmApply: async () => false,
    };
    await runSetup(options);
    expect(await readSettings(home)).toBe(null);
    expect(logins).toBe(state === "valid" ? 0 : 1);
    expect(connections).toBe(state === "missing" ? 1 : 0);
    expect(output.join("\n")).toMatch(/Alice · Acme/);
    expect(output.join("\n")).toMatch(/Setup cancelled/);
    expect((await readCredentials(home)).selectedServer).toBe(origin);
    expect(output.join("\n")).not.toContain(token);

    await runSetup({ ...options, confirmApply: async () => true });
    const saved = await readSettings(home);
    expect(saved?.version).toBe(2);
    if (saved?.version !== 2) throw new Error("Expected connected settings");
    expect(saved.connection?.server).toBe(origin);
    expect(saved.knowledge).toBe(true);
    expect(saved.harnesses).toStrictEqual(["codex"]);
    expect(saved.environment?.individualAssetIds).toStrictEqual([mcpId]);
    expect(await readFile(join(home, ".codex/config.toml"), "utf8")).toMatch(
      /https:\/\/example.com\/mcp/,
    );
    expect(logins).toBe(state === "valid" ? 0 : 1);
    if (state === "valid") {
      await environmentOperation(
        "sets-install",
        { origin: "org", mode: "all" },
        home,
      );
      const preview = (await environmentOperation(
        "sets-preview",
        { origin: "org" },
        home,
      )) as { assets: { id: string }[] };
      expect(preview.assets.map((asset) => asset.id)).toStrictEqual([mcpId]);
      const original = await readFile(settingsPath(home), "utf8");
      await expect(
        environmentOperation(
          "sets-install-custom",
          { origin: "org", assetIds: [randomUUID()] },
          home,
        ),
      ).rejects.toThrow(/unavailable assets/);
      expect(await readFile(settingsPath(home), "utf8")).toBe(original);
      await environmentOperation(
        "sets-install-custom",
        { origin: "org", assetIds: [] },
        home,
      );
      expect(await readFile(settingsPath(home), "utf8")).toBe(original);
      await environmentOperation(
        "sets-install-custom",
        { origin: "org", assetIds: [mcpId] },
        home,
      );
      const custom = await readSettings(home);
      assert(custom?.version === 2);
      expect(custom.environment?.subscriptions).toStrictEqual([]);
      expect(custom.environment?.individualAssetIds).toStrictEqual([mcpId]);
    }
    const before = await readFile(settingsPath(home), "utf8");
    failCatalog = true;
    await expect(
      runSetup({ ...options, restart: true, confirmRestart: async () => true }),
    ).rejects.toThrow();
    expect(await readFile(settingsPath(home), "utf8")).toBe(before);
  });
}

test("local setup is explicit and final cancellation preserves saved settings", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "barndog-local-setup-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  await saveSettings({ version: 1, harnesses: ["claude"], skills: [] }, home);
  await runSetup({
    home,
    restart: true,
    interactive: true,
    local: true,
    detected: [],
    write: () => {},
    confirmRestart: async () => true,
    chooseConnection: async () => {
      throw new Error("Must not connect");
    },
    choose: async () => ["codex"],
    confirmApply: async () => false,
  });
  expect((await readSettings(home))?.harnesses).toStrictEqual(["claude"]);
});
