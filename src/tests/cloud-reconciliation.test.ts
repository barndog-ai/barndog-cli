import { assert, expect, test, type TestContext } from "vitest";
import { join } from "node:path";
import { readFile, writeFile, rm } from "node:fs/promises";
import * as contract from "@barndog-ai/api-contract";
import { cloud, ID, type Cloud } from "./cloud.js";
import { CliError } from "../shared/cli-error.js";
import { sample } from "./sample.js";
import { testRuntime } from "./runtime.js";
import {
  pushWorkspace,
  updateWorkspace,
  resolveConflict,
  createWorkspace,
} from "../features/collaboration/workspace.js";
import { find, save } from "../features/collaboration/workspace-store.js";

async function fixture(t: TestContext) {
  const server = await cloud(t);
  const cwd = join(server.home, "copy");
  await server.run([
    "skills",
    "pull",
    "release-notes",
    "--origin",
    "org",
    "--directory",
    cwd,
  ]);

  const runtime = testRuntime(server.home, { cwd });
  const path = join(cwd, "SKILL.md");
  await writeFile(path, (await readFile(path, "utf8")) + "\nLocal edit\n");
  await pushWorkspace({}, runtime);

  return { server, runtime, path };
}

const NEW_VERSION_ID = "22222222-2222-4222-8222-222222222222";

/** A server that has revised the open proposal onto the given base. */
function revisedProposal(
  server: Cloud,
  base: "same" | "new" | "missing" | "none",
) {
  const baseVersionId = {
    same: ID,
    new: NEW_VERSION_ID,
    missing: NEW_VERSION_ID,
    none: null,
  }[base];

  server.respond(
    "GET",
    `/v1/skill-changes/${ID}`,
    sample(contract.changeSchema, {
      revision: 2,
      baseVersionId,
      publishedVersion: null,
    }),
  );

  if (base === "new" || base === "missing") {
    const version = sample(contract.versionSchema, {
      id: NEW_VERSION_ID,
      number: 2,
    });

    server.respond(
      "GET",
      "/v1/skills/[^/]+/versions",
      base === "new" ? [version] : [],
    );

    server.respond("GET", "/v1/skills/[^/]+", {
      ...sample(contract.skillSchema),
      version,
    });
  }
}

const bases = {
  same: { baseVersion: 1, baseVersionId: ID },
  new: { baseVersion: 2, baseVersionId: NEW_VERSION_ID },
  none: { baseVersion: null, baseVersionId: null },
} as const;

for (const [base, expected] of Object.entries(bases)) {
  test(`pull adopts a revised proposal rebased onto ${base} base version and keeps the local edit`, async (t) => {
    const { server, runtime, path } = await fixture(t);
    const before = await find(runtime);
    const unpushed = join(runtime.cwd, "notes.md");
    await writeFile(unpushed, "Unpushed notes\n");
    revisedProposal(server, base as keyof typeof bases);

    const updated = await updateWorkspace(runtime);

    expect(updated.baseVersion).toBe(expected.baseVersion);
    const work = await find(runtime);
    expect(work.proposal).toMatchObject({ id: ID, revision: 2 });
    expect(work.baseVersionId).toBe(expected.baseVersionId);
    expect(work.baseNumber).toBe(expected.baseVersion);
    expect(before.proposal?.revision).toBe(1);
    // The revision on the server replaced the pushed edit; unpushed work survives.
    expect(await readFile(path, "utf8")).not.toContain("Local edit");
    expect(await readFile(unpushed, "utf8")).toBe("Unpushed notes\n");
    expect(work.conflicts).toEqual([]);
  });
}

test("pull fails when the revised proposal's base version is not on the server, leaving the saved copy unchanged", async (t) => {
  const { server, runtime, path } = await fixture(t);
  const before = await find(runtime);
  const local = await readFile(path, "utf8");
  revisedProposal(server, "missing");

  await expect(updateWorkspace(runtime)).rejects.toThrow(
    "didn't return the version",
  );

  expect(await find(runtime)).toEqual(before);
  expect(await readFile(path, "utf8")).toBe(local);
});

test("pushing after the proposal was merged asks to pull first", async (t) => {
  const { server, runtime } = await fixture(t);
  server.respond(
    "GET",
    `/v1/skill-changes/${ID}`,
    sample(contract.changeSchema, {
      status: "merged",
      publishedVersion: {
        ...sample(contract.versionSchema),
        id: NEW_VERSION_ID,
      },
    }),
  );

  const sent = server.requests.length;
  const error = await pushWorkspace({}, runtime).catch((e: unknown) => e);

  assert(error instanceof CliError);
  expect(error.message).toContain("merged. Pull it");
  expect(error.hint).toBe("barndog pull");
  expect(
    server.requests.slice(sent).filter((r) => r.startsWith("POST")),
  ).toEqual([]);
});

test("pushing after the proposal was rejected requires --new, which opens a second proposal", async (t) => {
  const { server, runtime } = await fixture(t);
  server.respond(
    "GET",
    `/v1/skill-changes/${ID}`,
    sample(contract.changeSchema, { status: "rejected" }),
  );

  const sent = server.requests.length;
  const error = await pushWorkspace({}, runtime).catch((e: unknown) => e);

  assert(error instanceof CliError);
  expect(error.message).toContain("rejected");
  expect(error.hint).toBe("barndog push --new");
  expect(
    server.requests.slice(sent).filter((r) => r.startsWith("POST")),
  ).toEqual([]);

  await pushWorkspace({ new: true }, runtime);
  expect(
    server.requests.filter((request) => request === "POST /v1/skill-changes"),
  ).toHaveLength(2);
});

test("a submitted copy cannot change scope, and nothing is sent", async (t) => {
  const { server, runtime } = await fixture(t);
  const team = sample(contract.scopeSchema, {
    type: "team",
    id: NEW_VERSION_ID,
    slug: "web",
  });

  server.respond("GET", "/v1/scopes", [sample(contract.scopeSchema), team]);
  const before = await find(runtime);
  const sent = server.requests.length;

  const error = await pushWorkspace({ origin: "team/web" }, runtime).catch(
    (e: unknown) => e,
  );

  assert(error instanceof CliError);
  expect(error.message).toContain("origin can't change");
  expect(error.hint).toBe("barndog push");
  expect(
    server.requests.slice(sent).filter((r) => /^(?:POST|PUT) /.test(r)),
  ).toEqual([]);

  expect((await find(runtime)).origin).toEqual(before.origin);
});

test("direct publication is refused without publish permission, and nothing is sent", async (t) => {
  const { server, runtime } = await fixture(t);
  server.respond("GET", "/v1/scopes", [
    sample(contract.scopeSchema, { canPublish: false }),
  ]);

  const sent = server.requests.length;
  const error = await pushWorkspace({ publish: true }, runtime).catch(
    (e: unknown) => e,
  );

  assert(error instanceof CliError);
  expect(error.message).toContain("Only a scope admin");
  expect(error.hint).toBe("barndog push");
  expect(
    server.requests.slice(sent).filter((r) => /^(?:POST|PUT) /.test(r)),
  ).toEqual([]);
});

test("conflicted copies reject pulls and pushes until resolved, including deleted resolutions", async (t) => {
  const { runtime, path } = await fixture(t);
  const work = await find(runtime);
  work.conflicts = ["SKILL.md"];
  await save(work, runtime);
  await expect(updateWorkspace(runtime)).rejects.toThrow("existing conflicts");
  await expect(pushWorkspace({}, runtime)).rejects.toThrow(
    "Resolve the conflicts",
  );

  await expect(resolveConflict("other", runtime)).rejects.toThrow(
    "isn't an unresolved",
  );

  await writeFile(
    path,
    "<<<<<<< local\nlocal\n=======\nremote\n>>>>>>> remote\n",
  );

  await expect(resolveConflict("SKILL.md", runtime)).rejects.toThrow(
    "still has conflict markers",
  );

  await rm(path);
  expect(await resolveConflict("SKILL.md", runtime)).toEqual({
    resolved: "SKILL.md",
    remaining: [],
  });

  expect((await find(runtime)).conflicts).toEqual([]);
});

test("new working folders validate names and can change scope before submission", async (t) => {
  const server = await cloud(t);
  const runtime = testRuntime(server.home, { cwd: server.home });
  await expect(
    createWorkspace(
      { kind: "skill", name: "Bad Name", origin: "org" },
      { runtime },
    ),
  ).rejects.toThrow("isn't a valid name");

  const result = await createWorkspace(
    { kind: "skill", name: "new-skill", origin: "org" },
    { runtime },
  );

  const team = sample(contract.scopeSchema, {
    type: "team",
    id: "22222222-2222-4222-8222-222222222222",
    slug: "web",
  });

  server.respond("GET", "/v1/scopes", [sample(contract.scopeSchema), team]);
  await pushWorkspace({ origin: "team/web" }, { ...runtime, cwd: result.root });
  expect(
    server.sent.findLast((item) => item.request === "POST /v1/skill-changes")!
      .body,
  ).toMatchObject({ origin: { type: "team", id: team.id } });
});
