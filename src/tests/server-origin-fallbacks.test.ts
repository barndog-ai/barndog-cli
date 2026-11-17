import { expect, test } from "vitest";
import * as contract from "@barndog-ai/api-contract";
import { selectOrigin, originLabel } from "../features/server/origin.js";
import { publishedHooks } from "../features/hooks/catalog.js";
import { mcpCatalog } from "../features/mcps/catalog.js";
import { publishedSkills } from "../features/skills/catalog.js";
import { cloud } from "./cloud.js";
import { sample } from "./sample.js";
import { readSettings } from "../config/settings.js";
import { testRuntime } from "./runtime.js";

for (const admin of [false, true]) {
  test(`personal scope fallback requires matching member and admin access (admin=${admin})`, async (t) => {
    const server = await cloud(t);
    const runtime = testRuntime(server.home);
    const conn = (await readSettings(server.home))!.connection!;
    const actor = sample(contract.contextSchema);
    server.respond("GET", "/v1/context", {
      ...actor,
      developer: {
        ...actor.developer,
        role: admin ? "organization_admin" : "developer",
      },
    });

    const member = sample(contract.memberSchema, {
      id: "22222222-2222-4222-8222-222222222222",
      slug: "bob",
    });

    server.respond("GET", "/v1/organization/members", [
      sample(contract.memberSchema),
      member,
    ]);

    if (admin) {
      expect(await selectOrigin("dev/bob", conn, runtime)).toMatchObject({
        id: member.id,
        canPublish: true,
      });
    } else {
      await expect(selectOrigin("dev/bob", conn, runtime)).rejects.toThrow(
        "No scope named",
      );
    }

    await expect(selectOrigin("dev/missing", conn, runtime)).rejects.toThrow(
      "No scope named",
    );

    await expect(selectOrigin("dev", conn, runtime)).rejects.toThrow(
      "No scope named",
    );

    await expect(selectOrigin("team/missing", conn, runtime)).rejects.toThrow(
      "No scope named",
    );
  });
}

test("catalogs refuse assets from a different organization", async (t) => {
  const server = await cloud(t);
  const runtime = testRuntime(server.home);
  const conn = (await readSettings(server.home))!.connection!;
  const organizationId = "22222222-2222-4222-8222-222222222222";
  server.respond(
    "GET",
    "/v1/hooks",
    sample(contract.hookListSchema, {
      hooks: [sample(contract.hookSchema, { organizationId })],
      nextCursor: null,
    }),
  );

  await expect(publishedHooks(conn, runtime)).rejects.toThrow(
    "another organization",
  );

  server.respond(
    "GET",
    "/v1/mcps",
    sample(contract.mcpListSchema, {
      mcps: [sample(contract.mcpSchema, { organizationId })],
      nextCursor: null,
    }),
  );

  await expect(mcpCatalog(conn, runtime)).rejects.toThrow(
    "another organization",
  );

  server.respond(
    "GET",
    "/v1/skills",
    sample(contract.listOutputSchema, {
      skills: [sample(contract.skillSchema, { organizationId })],
      nextCursor: null,
    }),
  );

  await expect(publishedSkills(conn, runtime)).rejects.toThrow(
    "another organization",
  );

  expect(originLabel({ type: "team" })).toBe("team/unknown");
  expect(originLabel({ type: "local" })).toBe("local");
});

test("Skill catalogs reject identity changes and duplicate entries", async (t) => {
  const server = await cloud(t);
  const runtime = testRuntime(server.home);
  const conn = (await readSettings(server.home))!.connection!;
  const actor = sample(contract.contextSchema);
  for (const field of ["organization", "developer"] as const) {
    server.respond("GET", "/v1/context", {
      ...actor,
      [field]: { ...actor[field], id: "22222222-2222-4222-8222-222222222222" },
    });

    await expect(publishedSkills(conn, runtime)).rejects.toThrow(
      "changed since this machine",
    );
  }

  server.respond("GET", "/v1/context", actor);
  const skill = sample(contract.skillSchema);
  server.respond(
    "GET",
    "/v1/skills",
    sample(contract.listOutputSchema, {
      skills: [skill, skill],
      nextCursor: null,
    }),
  );

  await expect(publishedSkills(conn, runtime)).rejects.toThrow(
    "same Skill twice",
  );
});
