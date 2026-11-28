import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, test, type TestContext } from "vitest";
import { barndogPaths } from "../config/paths.js";
import { readState } from "../config/state.js";
import { cloud, MCP_ID, type Cloud } from "./cloud.js";

/** A Cloud machine that synced the sample MCP server, `release-notes`, which refers to `secretRef`. */
async function synced(t: TestContext) {
  const server = await cloud(t, {
    harnesses: ["claude"],
    environment: {
      subscriptions: [],
      individualAssetIds: [MCP_ID],
      excludedAssetIds: [],
      disabledAssetIds: [],
    },
  });

  await server.run(["sync"]);

  return server;
}

/** Every request from now on fails as fetch does with no network. */
function goOffline(server: Cloud) {
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    server.respond(method, ".*", () => {
      throw new TypeError("fetch failed");
    });
  }
}

const run = async (server: Cloud, args: string[]) =>
  stripVTControlCharacters(await server.run(args));

const kept = async (server: Cloud) =>
  JSON.parse(await readFile(barndogPaths(server.home).secrets, "utf8"));

test("offline, set keeps a value for an enabled Cloud server and says the tools get it on the next sync", async (t) => {
  const server = await synced(t);
  goOffline(server);

  const output = await run(server, [
    "mcp",
    "env",
    "set",
    "release-notes",
    "secretRef",
    "--from",
    "NOTES_TOKEN",
  ]);

  expect(output).toContain("release-notes reads secretRef from $NOTES_TOKEN.");
  expect(output).toContain(
    "Your coding tools weren't updated: Can't reach the BarnDog server",
  );

  expect(output).toContain("the next barndog sync writes it into them.");
  expect((await kept(server)).servers[MCP_ID]).toStrictEqual({
    secretRef: { from: "NOTES_TOKEN" },
  });

  const json = JSON.parse(
    await server.run([
      "mcp",
      "env",
      "unset",
      "release-notes",
      "secretRef",
      "--json",
    ]),
  );

  expect(json).toMatchObject({
    server: "release-notes",
    variable: "secretRef",
    notWritten: { because: "sync-failed", fix: "barndog doctor" },
  });
});

test("a disabled Cloud server keeps its name, and mcp env changes it without the network", async (t) => {
  const server = await synced(t);
  await server.run(["mcp", "disable", "release-notes"]);
  expect((await readState(server.home)).mcpServers).toMatchObject([
    { id: MCP_ID, installedName: "release-notes", enabled: false },
  ]);

  // An unchanged disabled server isn't read again on the next sync.
  const before = server.requests.length;
  await server.run(["sync"]);
  expect(server.requests.slice(before)).not.toContain(`GET /v1/mcps/${MCP_ID}`);

  goOffline(server);
  const offline = server.requests.length;

  const set = await run(server, [
    "mcp",
    "env",
    "set",
    "release-notes",
    "secretRef",
    "--from",
    "NOTES_TOKEN",
  ]);

  expect(set).toContain(
    "release-notes is disabled, so your coding tools get the change when you enable it.",
  );

  const listed = await run(server, ["mcp", "env", "list"]);
  expect(listed).toMatch(
    /release-notes\s+secretRef\s+reads \$NOTES_TOKEN\s+not written \(disabled\)/,
  );

  expect(listed).not.toContain(MCP_ID);
  expect(server.requests.slice(offline)).toStrictEqual([]);
  expect(
    JSON.parse(await readFile(join(server.home, ".claude.json"), "utf8"))
      .mcpServers,
  ).toStrictEqual({});
});
