import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test, type TestContext } from "vitest";
import type { McpDefinition } from "@barndog-ai/api-contract";
import { finishMoves } from "../features/environment/moves.js";
import {
  readSettings,
  saveSettings,
  type Settings,
} from "../config/settings.js";
import { localWorkspace } from "../features/workspace/setup.js";
import { localRepoSource } from "../features/workspace/repo-source.js";
import { readMoved, recordMoved } from "../features/workspace/overlay.js";
import type { WorkspaceSource } from "../features/workspace/source.js";
import type {
  AssetCatalog,
  AssetReference,
} from "../features/asset-selection/types.js";
import type { SelectionState } from "../config/selection.js";
import { changeSecrets, readStoredSecrets } from "../features/secrets/index.js";
import { testRuntime } from "./runtime.js";

const skill = (name: string, body = "Body.") =>
  `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`;

const docs: McpDefinition = {
  transport: "stdio",
  command: "docs",
  args: [],
  environment: {},
  description: "Docs",
  authentication: "none",
};

const empty: SelectionState = {
  subscriptions: [],
  individualAssetIds: [],
  excludedAssetIds: [],
  disabledAssetIds: [],
};

const team = randomUUID();

/** A local folder, and a shared copy of each asset in `shared/` beside it. */
async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "barndog-moves-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const runtime = testRuntime(home);
  const local = await localWorkspace(runtime);
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(local.path, path)), { recursive: true });
    await writeFile(join(local.path, path), text);
  };

  const shared = join(home, "shared");
  const ids = new Map<string, string>();
  const idOf = (name: string) => {
    ids.set(name, ids.get(name) ?? randomUUID());

    return ids.get(name)!;
  };

  const reference = (kind: "skill" | "mcp", name: string) => ({
    kind,
    id: idOf(name),
    name,
    origin: { type: "team" as const, id: team, slug: "web" },
    publishedVersion: "1",
  });

  const assets: AssetReference[] = [];
  const catalog: AssetCatalog = { assets, distributions: [] };
  const source: WorkspaceSource = {
    cacheKey: "fake",
    journal: { workspaceId: "fake" },
    catalog: async () => catalog,
    packageFolder: async (_, asset) => join(shared, asset.name),
    mcpDefinition: async () => docs,
    invalidAssets: async () => new Map(),
    notices: () => [],
  };

  // A Cloud connection beside the local folder; the fake source answers for it.
  const settings: Settings = {
    harnesses: [],
    localWorkspace: local,
    connection: {
      server: "https://barndog.example",
      organizationId: randomUUID(),
      developerId: randomUUID(),
    },
  };

  await saveSettings(settings, home);
  const settle = () =>
    finishMoves({
      settings,
      source,
      catalog,
      selection: empty,
      options: { catalog },
      configPath: undefined,
      runtime,
    });

  const saved = async () =>
    (await readSettings(home))?.environment?.individualAssetIds ?? [];

  return {
    local,
    write,
    shared,
    reference,
    assets,
    settle,
    saved,
    idOf,
    runtime,
  };
}

test("a move recorded without its version removes a local copy identical to the shared one", async (t) => {
  const f = await fixture(t);
  await f.write("org/skills/same/SKILL.md", skill("same"));
  await f.write("org/skills/edited/SKILL.md", skill("edited", "Mine."));
  await f.write(
    "org/mcp/docs.yaml",
    "transport: stdio\ncommand: docs\nargs: []\nenvironment: {}\ndescription: Docs\nauthentication: none\n",
  );

  for (const name of ["same", "edited"]) {
    await mkdir(join(f.shared, name), { recursive: true });
    await writeFile(join(f.shared, name, "SKILL.md"), skill(name));
  }

  f.assets.push(
    f.reference("skill", "same"),
    f.reference("skill", "edited"),
    f.reference("mcp", "docs"),
  );

  await recordMoved(f.local.path, [
    { kind: "skill", name: "same", path: "org/skills/same", originId: team },
    {
      kind: "skill",
      name: "edited",
      path: "org/skills/edited",
      originId: team,
    },
    { kind: "mcp", name: "docs", path: "org/mcp/docs.yaml", originId: team },
  ]);

  const result = await f.settle();

  await expect(lstat(join(f.local.path, "org/skills/same"))).rejects.toThrow();
  await expect(
    lstat(join(f.local.path, "org/mcp/docs.yaml")),
  ).rejects.toThrow();

  expect(
    await readFile(join(f.local.path, "org/skills/edited/SKILL.md"), "utf8"),
  ).toMatch(/Mine/);

  expect(result.notices.join("\n")).toMatch(
    /edited changed after it was moved/,
  );

  expect([...result.selection.individualAssetIds].sort()).toStrictEqual(
    ["docs", "edited", "same"].map(f.idOf).sort(),
  );

  // The selection is saved before any local copy goes.
  expect([...(await f.saved())].sort()).toStrictEqual(
    [...result.selection.individualAssetIds].sort(),
  );

  expect(await readMoved(f.local.path)).toStrictEqual([]);
});

test("a moved MCP server's kept values follow it to the shared copy", async (t) => {
  const f = await fixture(t);
  await f.write(
    "org/mcp/docs.yaml",
    "transport: stdio\ncommand: docs\nargs: []\nenvironment: {}\ndescription: Docs\nauthentication: none\n",
  );

  const local = (await localRepoSource(f.local, f.runtime).model()).assets.find(
    (asset) => asset.path === "org/mcp/docs.yaml",
  )!.id;

  await changeSecrets(
    () => ({
      servers: { [local]: { API_KEY: { value: "sk" } } },
      unassigned: {},
    }),
    f.runtime,
  );

  f.assets.push(f.reference("mcp", "docs"));
  await recordMoved(f.local.path, [
    { kind: "mcp", name: "docs", path: "org/mcp/docs.yaml", originId: team },
  ]);

  await f.settle();
  expect(await readStoredSecrets(f.runtime)).toStrictEqual({
    version: 2,
    servers: { [f.idOf("docs")]: { API_KEY: { value: "sk" } } },
    unassigned: {},
  });
});

test("a move still waiting for its shared copy stays recorded and says so", async (t) => {
  const f = await fixture(t);
  await f.write("org/skills/waiting/SKILL.md", skill("waiting"));
  await recordMoved(f.local.path, [
    {
      kind: "skill",
      name: "waiting",
      path: "org/skills/waiting",
      originId: team,
      version: "v",
      target: "team/web",
      url: "https://example.test/pull/1",
    },
    {
      kind: "skill",
      name: "gone",
      path: "org/skills/gone",
      originId: team,
      version: "v",
    },
  ]);

  f.assets.push(f.reference("skill", "gone"));
  const result = await f.settle();

  expect(result.notices).toStrictEqual([
    "waiting is still moving to https://example.test/pull/1. Your local copy stays in use until that merges.",
  ]);

  expect((await readMoved(f.local.path)).map((m) => m.name)).toStrictEqual([
    "waiting",
  ]);
});

test("knowledge moves wait for the shared document and keep an edited local file", async (t) => {
  const f = await fixture(t);
  const doc = "---\ndescription: Notes\n---\n# Notes\n";
  await f.write("org/knowledge/notes.md", doc);
  await f.write("org/knowledge/old.md", doc);
  const model = await localRepoSource(
    f.local,
    testRuntime(f.local.path),
  ).model();

  const version = model.knowledge.find((d) =>
    d.path.endsWith("notes.md"),
  )!.version;

  await recordMoved(f.local.path, [
    {
      kind: "knowledge",
      name: "notes",
      path: "org/knowledge/notes.md",
      version,
    },
    { kind: "knowledge", name: "old", path: "org/knowledge/old.md" },
    { kind: "knowledge", name: "missing", path: "org/knowledge/missing.md" },
  ]);

  const result = await f.settle();
  expect(result.notices.join("\n")).toMatch(/notes is still moving/);
  // Recorded before versions were kept: kept, since Cloud can't be compared.
  expect(result.notices.join("\n")).toMatch(/old changed after it was moved/);
  expect((await readMoved(f.local.path)).map((m) => m.name)).toStrictEqual([
    "notes",
  ]);
});

test("finishing a move stops following the asset's repository, and ignores paths the folder doesn't list", async (t) => {
  const f = await fixture(t);
  await f.write("org/skills/same/SKILL.md", skill("same"));
  await mkdir(join(f.shared, "same"), { recursive: true });
  await writeFile(join(f.shared, "same", "SKILL.md"), skill("same"));
  await f.write(
    ".barndog-sources.json",
    JSON.stringify({
      imports: [
        {
          kind: "skill",
          name: "same",
          mode: "auto",
          url: "https://example.test/repo",
          ref: null,
          root: "skills/same",
          commit: "c",
          fingerprint: "f",
        },
      ],
    }),
  );

  f.assets.push(f.reference("skill", "same"));
  await recordMoved(f.local.path, [
    { kind: "skill", name: "same", path: "org/skills/same", originId: team },
  ]);

  await f.settle();
  expect(
    JSON.parse(
      await readFile(join(f.local.path, ".barndog-sources.json"), "utf8"),
    ).imports,
  ).toStrictEqual([]);

  // A record whose path the folder doesn't list touches nothing.
  await recordMoved(f.local.path, [
    { kind: "skill", name: "same", path: "org/skills/../..", originId: team },
  ]);

  await f.settle();
  expect(await readMoved(f.local.path)).toStrictEqual([]);
  expect((await lstat(f.local.path)).isDirectory()).toBe(true);
});
