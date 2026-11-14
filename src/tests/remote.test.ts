import { updateCredentials } from "../features/auth/credentials.js";
import { expect, test, type TestContext } from "vitest";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@barndog-ai/api-contract";
import { publishedSkills } from "../features/skills/catalog.js";

async function fixture(t: TestContext) {
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
    expect(request.headers.authorization).toBe(`Bearer ${"a".repeat(43)}`);
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
  if (!address || typeof address === "string") {
    throw new Error("Missing test server");
  }

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

  t.onTestFinished(async () => {
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

test("publishedSkills retrieves every page before selection; rejects malformed and cyclic pagination", async (t) => {
  const f = await fixture(t);
  expect((await publishedSkills(f.connection, f.home)).length).toBe(105);
  f.repeat();
  await expect(publishedSkills(f.connection, f.home)).rejects.toThrow(
    /pagination/,
  );

  f.malformed();
  await expect(publishedSkills(f.connection, f.home)).rejects.toThrow();
});
