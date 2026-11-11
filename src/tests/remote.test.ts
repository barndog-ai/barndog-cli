import { updateCredentials } from "../features/auth/credentials.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
  readlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@barndog-ai/api-contract";
import { catalog, connect } from "../features/skills/remote.js";
import {
  readSettings,
  saveSettings,
  settingsPath,
} from "../config/settings.js";
import { initialize } from "../features/onboarding/setup.js";
import { sync } from "../features/skills/sync.js";

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "barndog-remote-")));
  const org = randomUUID();
  const dev = randomUUID();
  let failure = false;
  let malformed = false;
  let repeatCursor = false;
  const skills: Skill[] = Array.from({ length: 105 }, (_, index) => {
    const id = randomUUID();
    return {
      id,
      organizationId: org,
      name: `skill-${index}`,
      origin: { type: "org", id: org, slug: "local" },
      createdBy: dev,
      createdAt: new Date().toISOString(),
      version: {
        id: randomUUID(),
        skillId: id,
        number: 1,
        commit: "a".repeat(40),
        description: "Example",
        publishedBy: dev,
        publishedAt: new Date().toISOString(),
      },
      distributions: [],
    };
  });
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${"a".repeat(43)}`);
    response.setHeader("content-type", "application/json");
    if (failure) {
      response.writeHead(503);
      response.end("unavailable");
      return;
    }
    const url = new URL(request.url!, "http://localhost");
    if (url.pathname === "/v1/context") {
      response.end(
        JSON.stringify({
          organization: { id: org, slug: "local", name: "Local" },
          developer: {
            id: dev,
            slug: "admin",
            name: "Admin",
            role: "organization_admin",
          },
        }),
      );
      return;
    }
    if (url.pathname === "/v1/skills") {
      const input = { cursor: url.searchParams.get("cursor") };
      const offset = input.cursor
        ? skills.findIndex((skill) => skill.id === input.cursor) + 1
        : 0;
      const page = skills.slice(offset, offset + 100);
      response.end(
        JSON.stringify(
          malformed
            ? { skills: null }
            : {
                skills: page,
                nextCursor: repeatCursor
                  ? skills[99]!.id
                  : offset + 100 < skills.length
                    ? page.at(-1)!.id
                    : null,
                total: skills.length,
              },
        ),
      );
      return;
    }
    response.writeHead(404);
    response.end("missing package");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test server");
  const connection = {
    server: `http://127.0.0.1:${address.port}`,
    organizationId: org,
    developerId: dev,
  };
  await updateCredentials(home, (credentials) => {
    credentials.servers[connection.server] = {
      token: "a".repeat(43),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      context: {
        organization: { id: org, slug: "local", name: "Local" },
        developer: {
          id: dev,
          slug: "admin",
          name: "Admin",
          role: "organization_admin",
        },
      },
    };
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(home, { recursive: true, force: true });
  });
  return {
    home,
    connection,
    skills,
    fail: () => {
      failure = true;
    },
    malformed: () => {
      malformed = true;
    },
    repeat: () => {
      repeatCursor = true;
    },
  };
}

test("catalog retrieves every page before selection; rejects malformed and cyclic pagination", async (t) => {
  const f = await fixture(t);
  assert.equal((await catalog(f.connection, f.home)).length, 105);
  f.repeat();
  await assert.rejects(catalog(f.connection, f.home), /pagination/);
  f.malformed();
  await assert.rejects(catalog(f.connection, f.home));
});
test("connecting upgrades v1 only on requested save and keeps local sources and activation", async (t) => {
  const f = await fixture(t);
  const skills = [{ id: randomUUID(), source: "../my-skill", enabled: false }];
  await saveSettings({ version: 1, skills, harnesses: ["codex"] }, f.home);
  const before = await readFile(settingsPath(f.home), "utf8");
  await readSettings(f.home);
  assert.equal(await readFile(settingsPath(f.home), "utf8"), before);
  await connect(f.connection.server, f.home);
  const after = await readSettings(f.home);
  assert.equal(after!.version, 2);
  assert.deepEqual(after!.skills, [{ ...skills[0], kind: "local" }]);
  assert.deepEqual(after!.harnesses, ["codex"]);
  f.fail();
  const saved = await readFile(settingsPath(f.home), "utf8");
  await assert.rejects(
    initialize({
      home: f.home,
      server: f.connection.server,
      detected: [],
      choose: async () => ["claude"],
    }),
  );
  assert.equal(await readFile(settingsPath(f.home), "utf8"), saved);
});
test("API failures, missing selections and failed downloads preserve installed local files and state", async (t) => {
  const f = await fixture(t);
  const source = join(f.home, "local-skill");
  await mkdir(source);
  await writeFile(
    join(source, "SKILL.md"),
    "---\nname: local-skill\ndescription: local\n---\n",
  );
  await saveSettings(
    {
      version: 1,
      harnesses: ["codex"],
      skills: [{ id: randomUUID(), source, enabled: true }],
    },
    f.home,
  );
  await sync(undefined, f.home);
  const installed = join(f.home, ".agents", "skills", "local-skill");
  const statePath = join(f.home, ".barndog", "state.json");
  const previous = await readFile(statePath, "utf8");
  await connect(f.connection.server, f.home);
  const next = await readSettings(f.home);
  if (!next || next.version !== 2) throw new Error("Expected v2");
  next.skills.push({ kind: "api", id: randomUUID(), enabled: true });
  await saveSettings(next, f.home);
  await assert.rejects(sync(undefined, f.home), /missing from the server/);
  next.skills.pop();
  next.skills.push({ kind: "api", id: f.skills[0]!.id, enabled: true });
  await saveSettings(next, f.home);
  await assert.rejects(sync(undefined, f.home), /Package download failed/);
  f.malformed();
  await assert.rejects(sync(undefined, f.home));
  f.fail();
  await assert.rejects(sync(undefined, f.home));
  assert.equal(await readlink(installed), source);
  assert.equal(await readFile(statePath, "utf8"), previous);
  // A v2 local-only configuration remains independent of server availability.
  next.skills = next.skills.filter((skill) => skill.kind === "local");
  await saveSettings(next, f.home);
  assert.ok(
    (await sync(undefined, f.home)).every(
      (event) => event.type === "unchanged",
    ),
  );
});
