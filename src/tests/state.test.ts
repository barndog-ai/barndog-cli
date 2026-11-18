import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type TestContext } from "vitest";
import { CliError } from "../errors.js";
import { readState } from "../config/state.js";
import { nativeFile } from "../harnesses/registry.js";
import { barndogPaths } from "../config/paths.js";

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "barndog-state-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const path = barndogPaths(home).state;
  await mkdir(join(home, ".barndog"));

  return {
    home,
    save: (value: unknown) => writeFile(path, JSON.stringify(value)),
  };
}

test("missing state returns every section empty", async (t) => {
  const { home } = await fixture(t);
  expect(await readState(home)).toEqual({
    version: 1,
    links: [],
    native: [],
    installed: [],
  });
});

test("reads complete state and preserves opaque native values", async (t) => {
  const { home, save } = await fixture(t);
  const state = {
    version: 1,
    links: [],
    native: [
      {
        id: "startup",
        kind: "sync",
        harness: "claude",
        file: nativeFile("claude", "sync", home),
        key: "SessionStart",
        value: { hooks: [{ command: "echo ok", extra: [1, null] }] },
      },
    ],
    installed: [
      {
        id: "asset",
        kind: "skill",
        path: join(barndogPaths(home).installed("skill"), "example"),
        fingerprint: "hash",
        versionId: "version",
      },
    ],
  };

  await save(state);
  expect(await readState(home)).toEqual(state);
});

test.for([
  { version: 2 },
  { links: [{ id: "invalid" }] },
  { native: [{ kind: "mcp", harness: "unknown" }] },
  {
    native: [
      {
        id: "mcp",
        kind: "mcp",
        harness: "claude",
        file: "/outside",
        key: "server",
        value: {},
      },
    ],
  },
  {
    installed: [
      { id: "asset", kind: "skill", path: "/outside", fingerprint: "hash" },
    ],
  },
  {
    installed: [
      { id: "asset", kind: "mcp", path: "/outside", fingerprint: "hash" },
    ],
  },
])("rejects malformed or unsafe sections: %j", async (patch, t) => {
  const { home, save } = await fixture(t);
  await save({ version: 1, links: [], ...patch });
  const failure = await readState(home).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(CliError);
  expect(failure).toHaveProperty(
    "message",
    expect.stringMatching(/state\.json is damaged/),
  );
});

test("a truncated state file is a damaged file with a fix, not a JSON parse error", async (t) => {
  const { home } = await fixture(t);
  await writeFile(barndogPaths(home).state, '{"version":1,"links":[');

  const failure = await readState(home).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(CliError);
  expect(failure).toHaveProperty(
    "hint",
    expect.stringMatching(/Undo any edit/),
  );
});
