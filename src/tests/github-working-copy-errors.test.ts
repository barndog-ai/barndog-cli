import { assert, expect, test, type TestContext } from "vitest";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import * as contract from "@barndog-ai/api-contract";
import { cloud, ID, COMMIT } from "./cloud.js";
import { sample } from "./sample.js";
import { testRuntime } from "./runtime.js";
import {
  pushWorkspace,
  updateWorkspace,
  workspaceStatus,
} from "../features/collaboration/workspace.js";
import { find } from "../features/collaboration/workspace-store.js";
import { CliError } from "../shared/cli-error.js";
import { HTTP_STATUS } from "../shared/constants.js";

async function fixture(t: TestContext) {
  const server = await cloud(t);
  const cwd = join(server.home, "copy");
  const source = sample(contract.gitConnectionSchema, {
    assetId: ID,
    kind: "skill",
    authority: "github",
    status: "active",
    syncedCommit: COMMIT,
  });

  const pull = sample(contract.gitPullSchema, {
    number: 7,
    head: "b".repeat(40),
    submittedCommit: undefined,
    state: "open",
    merged: false,
  });

  server.respond("GET", "/v1/git-connections", [source]);
  server.respond("POST", "/v1/git-connections/[^/]+/pulls", pull);
  server.respond("PUT", "/v1/git-connections/[^/]+/pulls/7/revisions", pull);
  server.respond("GET", "/v1/git-connections/[^/]+/pulls/7", {
    ...sample(contract.gitPullDetailsSchema),
    pull,
  });

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
  await pushWorkspace({ title: "Initial" }, runtime);

  return { server, runtime, source, pull, path: join(cwd, "SKILL.md") };
}

const LOCAL_EDIT = "\nLocal edit\n";

const OTHER_CONNECTION = "22222222-2222-4222-8222-222222222222";

const writes = (requests: string[]) =>
  requests.filter((request) => /^(?:POST|PUT) /.test(request));

type Refusal = { message: string; hint: string | undefined };

/** Each state that makes GitHub push refuse, with the message and fix the user sees. */
const refusals: Record<
  string,
  (f: Awaited<ReturnType<typeof fixture>>) => Promise<Refusal>
> = {
  disconnected: async ({ server }) => {
    server.respond("GET", "/v1/git-connections", []);

    return { message: "connection changed", hint: "barndog pull" };
  },
  changed: async ({ server, source }) => {
    server.respond("GET", "/v1/git-connections", [
      { ...source, id: OTHER_CONNECTION },
    ]);

    return { message: "connection changed", hint: "barndog pull" };
  },
  closed: async ({ server, pull }) => {
    server.respond("GET", "/v1/git-connections/[^/]+/pulls/7", {
      ...sample(contract.gitPullDetailsSchema),
      pull: { ...pull, state: "closed" },
    });

    return {
      message: "pull request is closed",
      hint: "barndog pull && barndog push --new",
    };
  },
  revised: async ({ server, pull }) => {
    server.respond("GET", "/v1/git-connections/[^/]+/pulls/7", {
      ...sample(contract.gitPullDetailsSchema),
      pull: { ...pull, head: "c".repeat(40) },
    });

    return { message: "changed on GitHub", hint: "barndog pull" };
  },
  published: async ({ server }) => {
    const asset = sample(contract.skillSchema);
    server.respond("GET", "/v1/skills/[^/]+", {
      ...asset,
      version: { ...asset.version, id: OTHER_CONNECTION },
    });

    return { message: "published content", hint: "barndog pull" };
  },
  renamed: async ({ path }) => {
    await writeFile(
      path,
      (await readFile(path, "utf8")).replaceAll("release-notes", "other"),
    );

    return { message: "name must stay release-notes", hint: undefined };
  },
  "sync-error": async ({ server, source }) => {
    server.respond("GET", "/v1/git-connections", [
      { ...source, status: "error", lastError: null },
    ]);

    return {
      message: "needs attention: error",
      hint: "barndog github list",
    };
  },
  "sync-error-detail": async ({ server, source }) => {
    server.respond("GET", "/v1/git-connections", [
      { ...source, status: "error", lastError: "Permission denied" },
    ]);

    return {
      message: "needs attention: Permission denied",
      hint: "barndog github list",
    };
  },
};

for (const [issue, arrange] of Object.entries(refusals)) {
  test(`GitHub push refuses the ${issue} state, sends nothing and keeps the local edit`, async (t) => {
    const state = await fixture(t);
    const { server, runtime, path } = state;
    await writeFile(path, (await readFile(path, "utf8")) + LOCAL_EDIT);
    const { message, hint } = await arrange(state);
    const before = await readFile(path, "utf8");
    const sent = server.requests.length;

    const error = await pushWorkspace({}, runtime).catch((e: unknown) => e);
    assert(error instanceof CliError);
    expect(error.message).toContain(message);
    expect(error.hint).toBe(hint);

    expect(await readFile(path, "utf8")).toBe(before);
    expect(before).toContain(LOCAL_EDIT.trim());
    expect(writes(server.requests.slice(sent))).toEqual([]);
    expect((await find(runtime)).external?.pending).toBeUndefined();
  });
}

test("an ambiguous GitHub revision failure retains the exact request and blocks pulling until it is retried", async (t) => {
  const { server, runtime, path, pull } = await fixture(t);
  await writeFile(path, (await readFile(path, "utf8")) + LOCAL_EDIT);
  server.respond("PUT", "/v1/git-connections/[^/]+/pulls/7/revisions", () => {
    throw new TypeError("reset");
  });

  await expect(pushWorkspace({}, runtime)).rejects.toThrow(
    "Can't reach the BarnDog server",
  );

  expect((await workspaceStatus(runtime)).pending).toBe(true);
  const error = await updateWorkspace(runtime).catch((e: unknown) => e);
  assert(error instanceof CliError);
  expect(error.message).toContain("Retry it before pulling");
  expect(error.hint).toBe("barndog push");

  const original = server.sent.findLast((item) =>
    item.request.includes("/revisions"),
  )!.body;

  server.respond("PUT", "/v1/git-connections/[^/]+/pulls/7/revisions", pull);
  await pushWorkspace({ title: "Ignored on retry" }, runtime);
  expect(
    server.sent.findLast((item) => item.request.includes("/revisions"))!.body,
  ).toEqual(original);

  expect((await workspaceStatus(runtime)).pending).toBe(false);
});

test("a definitive GitHub revision refusal clears the pending push, keeps the local edit and allows pulling", async (t) => {
  const { server, runtime, path } = await fixture(t);
  await writeFile(path, (await readFile(path, "utf8")) + LOCAL_EDIT);
  server.respond("PUT", "/v1/git-connections/[^/]+/pulls/7/revisions", () =>
    Response.json({ message: "refused" }, { status: HTTP_STATUS.conflict }),
  );

  await expect(pushWorkspace({}, runtime)).rejects.toThrow("refused");

  expect((await workspaceStatus(runtime)).pending).toBe(false);
  expect(await readFile(path, "utf8")).toContain(LOCAL_EDIT.trim());
  const updated = await updateWorkspace(runtime);
  expect(updated.conflicts).toEqual([]);
  expect(await readFile(path, "utf8")).toContain(LOCAL_EDIT.trim());
});

test("pushing unchanged GitHub content reports the open pull request and sends nothing", async (t) => {
  const { server, runtime } = await fixture(t);
  const sent = server.requests.length;

  expect(await pushWorkspace({}, runtime)).toMatchObject({
    unchanged: true,
    pull: 7,
  });

  expect(writes(server.requests.slice(sent))).toEqual([]);
});

test("publishing unchanged GitHub content merges the open pull request at its head commit", async (t) => {
  const { server, runtime, pull } = await fixture(t);
  const sent = server.sent.length;

  await pushWorkspace({ publish: true }, runtime);

  expect(
    server.sent.slice(sent).filter((s) => /^(?:POST|PUT) /.test(s.request)),
  ).toEqual([
    {
      request: `PUT /v1/git-connections/${ID}/pulls/7/merge`,
      body: { expectedCommit: pull.head },
    },
  ]);
});

test("--new opens a fresh pull request even when the previous one is closed", async (t) => {
  const { server, runtime, pull } = await fixture(t);
  server.respond("GET", "/v1/git-connections/[^/]+/pulls/7", {
    ...sample(contract.gitPullDetailsSchema),
    pull: { ...pull, state: "closed" },
  });

  const sent = server.sent.length;
  await pushWorkspace({ new: true, title: "New proposal" }, runtime);

  const created = server.sent
    .slice(sent)
    .filter((s) => s.request === `POST /v1/git-connections/${ID}/pulls`);

  expect(created).toHaveLength(1);
  expect(created[0]!.body).toMatchObject({
    title: "New proposal",
    expectedCommit: COMMIT,
  });
});
