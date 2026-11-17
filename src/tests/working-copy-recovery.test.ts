import { expect, test, type TestContext } from "vitest";
import { join } from "node:path";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { cloud } from "./cloud.js";
import { testRuntime } from "./runtime.js";
import {
  find,
  findGit,
  save,
} from "../features/collaboration/workspace-store.js";
import { barndogPaths } from "../config/paths.js";
import { writeAtomic } from "../shared/files.js";
import { CliError, PackageError } from "../errors.js";

// `barndog pull` saves the working copy's files in a recovery snapshot, records
// the write it is about to make, writes, then clears the record. These tests
// leave that record behind, as a crash would, and run the next lookup.

/** A pulled working copy with an interrupted write of `incoming` recorded. */
async function interrupted(t: TestContext, incomingPath = "SKILL.md") {
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
  const work = await find(runtime);
  const snapshot = join(
    barndogPaths(server.home).workingCopySnapshots,
    "fixture.json",
  );

  await writeAtomic(snapshot, JSON.stringify({ files: work.base }));
  const file = join(cwd, "SKILL.md");
  const before = await readFile(file, "utf8");
  const incoming = before + "\nIncoming edit\n";
  work.pendingWrite = [
    {
      path: incomingPath,
      content: Buffer.from(incoming).toString("base64"),
      executable: false,
    },
  ];

  work.pendingSnapshot = snapshot;
  await save(work, runtime);

  return { server, runtime, work, snapshot, file, before, incoming };
}

test("an interrupted update of an untouched folder is finished on the next command", async (t) => {
  const { runtime, file, incoming } = await interrupted(t);

  const recovered = await find(runtime);

  expect(recovered.pendingWrite).toBeUndefined();
  expect(recovered.pendingSnapshot).toBeUndefined();
  expect(await readFile(file, "utf8")).toBe(incoming);
  expect((await find(runtime)).pendingWrite).toBeUndefined();
});

test("an interrupted update never overwrites edits made after it, and points at the snapshot", async (t) => {
  const { runtime, file, before, snapshot } = await interrupted(t);
  const edited = before + "\nManual edit\n";
  await writeFile(file, edited);

  const error: unknown = await find(runtime).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(CliError);
  expect(error).toHaveProperty(
    "message",
    `An interrupted update left edits it didn't make in SKILL.md. Save them elsewhere, then retry. The recovery snapshot is ${snapshot}.`,
  );

  expect(await readFile(file, "utf8")).toBe(edited);
});

const damage = {
  "doesn't point at a snapshot": {
    reason: "its record doesn't point at a recovery snapshot",
    apply: async (work: { pendingSnapshot?: string }) => {
      delete work.pendingSnapshot;
    },
  },
  "points outside the snapshots folder": {
    reason: "its record doesn't point at a recovery snapshot",
    apply: async (work: { pendingSnapshot?: string; root: string }) => {
      work.pendingSnapshot = join(work.root, "..", "snapshot.json");
    },
  },
  "names a snapshot that was deleted": {
    reason: "its recovery snapshot <snapshot> is gone",
    apply: async (work: { pendingSnapshot?: string }) => {
      await rm(work.pendingSnapshot!);
    },
  },
  "names a damaged snapshot": {
    reason: "its recovery snapshot <snapshot> is damaged",
    apply: async (work: { pendingSnapshot?: string }) => {
      await writeFile(work.pendingSnapshot!, "{");
    },
  },
};

for (const [situation, { reason, apply }] of Object.entries(damage)) {
  test(`an interrupted update whose record ${situation} leaves the folder alone and says how to start over`, async (t) => {
    const { server, runtime, work, snapshot, file, before } =
      await interrupted(t);

    await apply(work);
    await save(work, runtime);

    const error: unknown = await find(runtime).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({
      message: `An update of ${work.root} was interrupted, and ${reason.replace("<snapshot>", snapshot)}, so BarnDog left the folder as it is.`,
      hint: "Save any edits in the folder elsewhere, then remove its working-copy record and pull it again",
      command: expect.stringContaining(barndogPaths(server.home).workingCopies),
    });

    expect(await readFile(file, "utf8")).toBe(before);
  });
}

test("an interrupted write outside the working copy is refused and writes nothing", async (t) => {
  const { server, runtime, file, before } = await interrupted(t, "../outside");

  const error: unknown = await find(runtime).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(PackageError);
  expect(error).toHaveProperty("code", "UNSAFE_PACKAGE_ENTRY");
  await expect(access(join(server.home, "outside"))).rejects.toMatchObject({
    code: "ENOENT",
  });

  expect(await readFile(file, "utf8")).toBe(before);
});

test("Git commands reject Cloud working-copy registrations", async (t) => {
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

  await expect(findGit(testRuntime(server.home, { cwd }))).rejects.toThrow(
    "Cloud Workspace",
  );
});
