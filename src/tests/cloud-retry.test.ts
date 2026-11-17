import { Parser } from "tar";
import { expect, test } from "vitest";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import * as contract from "@barndog-ai/api-contract";
import { cloud, ID } from "./cloud.js";
import { sample } from "./sample.js";
import { testRuntime } from "./runtime.js";
import {
  pushWorkspace,
  updateWorkspace,
  workspaceStatus,
} from "../features/collaboration/workspace.js";
import { HTTP_STATUS } from "../shared/constants.js";

async function packageFiles(bytes: Buffer): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({
      onReadEntry(entry) {
        const chunks: Buffer[] = [];
        entry.on("data", (chunk: Buffer) => chunks.push(chunk));
        entry.on("end", () =>
          files.set(entry.path, Buffer.concat(chunks).toString("utf8")),
        );
      },
    });

    parser.on("error", reject);
    parser.on("end", resolve);
    parser.end(bytes);
  });

  return files;
}

for (const status of [
  HTTP_STATUS.badRequest,
  HTTP_STATUS.forbidden,
  HTTP_STATUS.notFound,
  HTTP_STATUS.conflict,
  HTTP_STATUS.payloadTooLarge,
]) {
  test(`definitive upload refusal ${status} clears pending state and retains local edits`, async (t) => {
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
    const content = (await readFile(path, "utf8")) + "\nLocal edit\n";
    await writeFile(path, content);
    server.respond("POST", "/v1/skill-changes", () =>
      Response.json({ message: "refused" }, { status }),
    );

    await expect(pushWorkspace({}, runtime)).rejects.toThrow("refused");
    expect((await workspaceStatus(runtime)).pending).toBe(false);
    expect(await readFile(path, "utf8")).toBe(content);
    await updateWorkspace(runtime);
  });
}

test("ambiguous upload retries the exact saved payload despite later folder edits", async (t) => {
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
  await writeFile(path, (await readFile(path, "utf8")) + "\nFirst edit\n");
  const uploads: Buffer[] = [];
  const capture = async (request: Request) => {
    const packageFile = (await request.clone().formData()).get("package");
    expect(packageFile).toBeInstanceOf(File);
    uploads.push(Buffer.from(await (packageFile as File).arrayBuffer()));
  };

  server.respond("POST", "/v1/skill-changes", async (request: Request) => {
    await capture(request);
    throw new TypeError("connection reset");
  });

  await expect(
    pushWorkspace({ title: "Original title" }, runtime),
  ).rejects.toThrow("Can't reach the BarnDog server");

  expect((await workspaceStatus(runtime)).pending).toBe(true);
  await expect(updateWorkspace(runtime)).rejects.toThrow(
    "Retry it before pulling",
  );

  const submitted = server.sent.find(
    (item) => item.request === "POST /v1/skill-changes",
  )!.body;

  await writeFile(path, (await readFile(path, "utf8")) + "\nLater edit\n");
  server.respond("POST", "/v1/skill-changes", async (request: Request) => {
    await capture(request);

    return sample(contract.changeSchema);
  });

  await pushWorkspace({ title: "Different title" }, runtime);
  expect(
    server.sent
      .filter((item) => item.request === "POST /v1/skill-changes")
      .at(-1)!.body,
  ).toEqual(submitted);

  expect(uploads).toHaveLength(2);
  expect(uploads[1]).toEqual(uploads[0]);
  const files = await packageFiles(uploads[1]!);
  expect(files.get("SKILL.md")).toContain("First edit");
  expect(files.get("SKILL.md")).not.toContain("Later edit");
  expect(await readFile(path, "utf8")).toContain("Later edit");
  const status = await workspaceStatus(runtime);
  expect(status.pending).toBe(false);
  expect(status.changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: "SKILL.md",
        patch: expect.stringContaining("Later edit"),
      }),
    ]),
  );
});

test("open proposals can be published without another upload and merged proposals are reusable", async (t) => {
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
  await writeFile(path, (await readFile(path, "utf8")) + "\nEdit\n");
  await pushWorkspace({}, runtime);
  const merged = sample(contract.changeSchema, { status: "merged" });
  server.respond("POST", `/v1/skill-changes/${ID}/merge`, merged);
  expect(await pushWorkspace({ publish: true }, runtime)).toMatchObject({
    status: "merged",
  });

  server.respond("GET", `/v1/skill-changes/${ID}`, merged);
  expect(await pushWorkspace({ publish: true }, runtime)).toMatchObject({
    status: "merged",
  });

  expect(
    server.requests.filter((request) => request === "POST /v1/skill-changes"),
  ).toHaveLength(1);
});
