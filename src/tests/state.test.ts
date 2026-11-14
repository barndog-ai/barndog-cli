import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type TestContext } from "vitest";
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

test("missing and legacy state return all sections", async (t) => {
  const { home, save } = await fixture(t);
  const empty = { version: 1, links: [], native: [], installed: [] };
  expect(await readState(home)).toEqual(empty);
  await save({ version: 1, links: [] });
  expect(await readState(home)).toEqual(empty);
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
  await expect(readState(home)).rejects.toThrow(/Invalid .*state/);
});

test("duplicate legacy links retain the actual symlink owner", async (t) => {
  const { home, save } = await fixture(t);
  await mkdir(join(home, ".claude/skills"), { recursive: true });
  const target = join(home, ".claude/skills/example");
  const first = {
    id: "11111111-1111-4111-8111-111111111111",
    harness: "claude",
    source: join(home, "first"),
    target,
  };

  const second = {
    ...first,
    id: "22222222-2222-4222-8222-222222222222",
    source: join(home, "second"),
  };

  await symlink(second.source, target);
  await save({ version: 1, links: [first, second] });
  expect((await readState(home)).links).toEqual([second]);
});
