import { mkdtemp, rm, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import {
  transact,
  locked,
  cleanUpIfInterrupted,
  type Write,
} from "../features/environment/transaction.js";
import { barndogPaths } from "../config/paths.js";
import { testRuntime } from "./runtime.js";
import { cloud, ID } from "./cloud.js";
import { writeAtomic } from "../shared/files.js";
import { CliError } from "../errors.js";

async function fixture(t: {
  onTestFinished: (fn: () => Promise<void>) => void;
}) {
  const home = await mkdtemp(join(tmpdir(), "barndog-transaction-guards-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));

  return { home, runtime: testRuntime(home), paths: barndogPaths(home) };
}

const DUPLICATE = "A sync planned an invalid or duplicate destination";
const INVALID = "A sync planned an invalid destination";

test("a sync refuses unsafe destinations before writing anything", async (t) => {
  const { home, runtime, paths } = await fixture(t);
  const tree: Write = {
    kind: "tree",
    path: join(paths.installed("skill"), "review"),
    before: null,
    after: "hash",
    source: join(home, "source"),
    rename: null,
  };

  const skillLink = join(home, ".claude/skills/review");
  const cases: [string, Write[], string][] = [
    [
      "relative file path",
      [{ kind: "file", path: "relative", before: null, after: "new" }],
      DUPLICATE,
    ],
    [
      "file BarnDog doesn't own",
      [
        {
          kind: "file",
          path: join(home, "outside"),
          before: null,
          after: "new",
        },
      ],
      INVALID,
    ],
    [
      "same file twice",
      [
        { kind: "file", path: paths.settings, before: null, after: "new" },
        { kind: "file", path: paths.settings, before: null, after: "new" },
      ],
      DUPLICATE,
    ],
    [
      "link outside every Skills folder",
      [
        {
          kind: "link",
          path: join(home, "outside"),
          before: null,
          after: home,
        },
      ],
      INVALID,
    ],
    [
      "link with a relative previous target",
      [{ kind: "link", path: skillLink, before: "relative", after: home }],
      INVALID,
    ],
    [
      "link with a relative new target",
      [{ kind: "link", path: skillLink, before: null, after: "relative" }],
      INVALID,
    ],
    [
      "installed folder outside ~/.barndog/installed",
      [{ ...tree, path: join(home, "outside") }],
      INVALID,
    ],
    [
      "installed folder with an invalid name",
      [{ ...tree, path: join(paths.installed("skill"), "Bad Name") }],
      INVALID,
    ],
    ["relative package source", [{ ...tree, source: "relative" }], INVALID],
    ["new content without a source", [{ ...tree, source: null }], INVALID],
    [
      "removal that still names a source",
      [{ ...tree, before: "existing", after: null }],
      INVALID,
    ],
    ["rename to an invalid name", [{ ...tree, rename: "Bad Name" }], INVALID],
  ];

  for (const [situation, writes, message] of cases) {
    await expect(transact(runtime, writes), situation).rejects.toThrow(
      new Error(message),
    );

    await expect(access(paths.pendingSync), situation).rejects.toMatchObject({
      code: "ENOENT",
    });

    for (const write of writes) {
      await expect(access(write.path), situation).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  }
});

for (const [damage, journal] of [
  ["isn't JSON", "{"],
  ["has the wrong shape", JSON.stringify({ version: 1, writes: "none" })],
  [
    "names a destination BarnDog never writes",
    JSON.stringify({
      version: 1,
      writes: [{ kind: "file", path: "/etc/hosts", before: null, after: "x" }],
    }),
  ],
] as const) {
  test(`an interrupted sync whose journal ${damage} is kept and nothing is applied`, async (t) => {
    const { runtime, paths } = await fixture(t);
    await writeAtomic(paths.pendingSync, journal);
    const run = vi.fn();

    const error: unknown = await locked(runtime, run).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({
      message: `${paths.pendingSync} is damaged, so BarnDog can't safely finish the interrupted sync.`,
      hint: "Move that file aside (keep it), check the files it lists, then run barndog sync",
    });

    expect(run).not.toHaveBeenCalled();
    expect(await readFile(paths.pendingSync, "utf8")).toBe(journal);
  });
}

test("a changed configuration backup stops the write and leaves config.yaml alone", async (t) => {
  const { runtime, paths } = await fixture(t);
  const original = "harnesses: []\n";
  await writeAtomic(paths.settings, original);
  const hash = createHash("sha256").update(original).digest("hex");
  const backup = join(paths.migrations, `config-${hash}.yaml`);
  await writeAtomic(backup, "changed backup");

  const error: unknown = await transact(runtime, [
    {
      kind: "file",
      path: paths.settings,
      before: original,
      after: "harnesses: [claude]\n",
    },
  ]).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(CliError);
  expect(error).toMatchObject({
    message: `${backup} was changed after BarnDog saved it, so ${paths.settings} was left as it is.`,
    hint: "Move that backup aside (keep it), then run the command again",
  });

  expect(await readFile(paths.settings, "utf8")).toBe(original);
  expect(await readFile(backup, "utf8")).toBe("changed backup");
  await expect(access(paths.pendingSync)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("recovery refuses a journal owned by another signed-in organization or developer", async (t) => {
  const server = await cloud(t);
  const runtime = testRuntime(server.home);
  const path = barndogPaths(server.home).pendingSync;
  for (const identity of [
    { organizationId: "22222222-2222-4222-8222-222222222222", developerId: ID },
    { organizationId: ID, developerId: "22222222-2222-4222-8222-222222222222" },
  ]) {
    await writeAtomic(
      path,
      JSON.stringify({
        version: 1,
        writes: [],
        connection: { server: "http://127.0.0.1:9", ...identity },
      }),
    );

    await expect(locked(runtime, async () => undefined)).rejects.toThrow(
      "another organization or developer",
    );

    await expect(access(path)).resolves.toBeUndefined();
  }
});

test("interruption cleanup runs once on a signal, forwards it, and unregisters on release", () => {
  const previous = process.listeners("SIGHUP");
  const cleanup = vi.fn();
  const release = cleanUpIfInterrupted(cleanup);
  const handler = process
    .listeners("SIGHUP")
    .find((listener) => !previous.includes(listener))!;

  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  try {
    handler("SIGHUP");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGHUP");
  } finally {
    release();
    kill.mockRestore();
  }

  expect(process.listeners("SIGHUP")).toEqual(previous);
});
