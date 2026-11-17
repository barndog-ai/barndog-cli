import { HTTP_STATUS } from "../shared/constants.js";
import { expect, test } from "vitest";
import { join } from "node:path";
import { readFile, writeFile, access } from "node:fs/promises";
import * as contract from "@barndog-ai/api-contract";
import { cloud, ID } from "./cloud.js";
import { sample } from "./sample.js";
import { pushWorkspace } from "../features/collaboration/workspace.js";
import { testRuntime } from "./runtime.js";

test("working copy rejects mismatched names and kinds and manifest renames", async (t) => {
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
  await expect(pushWorkspace({ kind: "hook" }, runtime)).rejects.toThrow(
    "not a hook",
  );

  await expect(pushWorkspace({ name: "other" }, runtime)).rejects.toThrow(
    "not other",
  );

  expect(await pushWorkspace({}, runtime)).toMatchObject({ unchanged: true });
  const file = join(cwd, "SKILL.md");
  await writeFile(
    file,
    (await readFile(file, "utf8")).replaceAll("release-notes", "different"),
  );

  await expect(pushWorkspace({}, runtime)).rejects.toThrow("name must stay");
});

test("failed download removes the new folder so the pull can be retried", async (t) => {
  const server = await cloud(t);
  const cwd = join(server.home, "copy");
  server.respond(
    "GET",
    "/v1/skills/[^/]+/versions/1/package",
    () =>
      new Response("unavailable", { status: HTTP_STATUS.internalServerError }),
  );

  await expect(
    server.run([
      "skills",
      "pull",
      "release-notes",
      "--origin",
      "org",
      "--directory",
      cwd,
    ]),
  ).rejects.toThrow("Downloading the package failed (500)");

  await expect(access(cwd)).rejects.toMatchObject({ code: "ENOENT" });
});

test("rejected or remotely revised proposals require explicit recovery before upload", async (t) => {
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
  const file = join(cwd, "SKILL.md");
  await writeFile(file, (await readFile(file, "utf8")) + "\nLocal edit\n");
  await pushWorkspace({}, runtime);
  server.respond(
    "GET",
    `/v1/skill-changes/${ID}`,
    sample(contract.changeSchema, { status: "rejected" }),
  );

  await expect(pushWorkspace({}, runtime)).rejects.toThrow("rejected");
  server.respond(
    "GET",
    `/v1/skill-changes/${ID}`,
    sample(contract.changeSchema, { status: "open", revision: 2 }),
  );

  await expect(pushWorkspace({}, runtime)).rejects.toThrow(
    "changed on the server",
  );
});
