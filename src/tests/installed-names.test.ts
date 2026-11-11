import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { parse as parseJson } from "jsonc-parser";
import {
  findClash,
  hookFolders,
  prefixedName,
  resolveClashes,
  restoreNames,
  type NamedAsset,
} from "../features/environment/names.js";
import {
  desiredEntries,
  installedRoot,
  mirrorTree,
  readTree,
  renameSkillEntries,
} from "../features/environment/installed.js";
import { recover, transact } from "../features/environment/transaction.js";
import {
  cacheKey,
  cacheRoot,
  pruneCache,
} from "../features/environment/packages.js";
import { packageFingerprint } from "@barndog-ai/api-contract/package";
import { synchronize } from "../features/environment/sync.js";
import {
  readSettings,
  saveSettings,
  type SettingsV2,
} from "../config/settings.js";
import { updateCredentials } from "../features/auth/credentials.js";
import { renderSyncOutput } from "../ui/output.js";
import { table } from "../ui/format.js";

const asset = (
  name: string,
  type: string,
  slug: string,
  installed = false,
): NamedAsset => ({
  id: randomUUID(),
  kind: "skill",
  name,
  origin: { type, slug },
  installed,
});

test("prefixed names use single hyphens and the origin type and slug", () => {
  assert.equal(
    prefixedName(asset("review-checklist", "team", "super-team")),
    "team-super-team-review-checklist",
  );
  assert.equal(
    prefixedName(asset("a--b", "dev", "John_Doe")),
    "dev-john-doe-a-b",
  );
});

test("the installed asset keeps its name; otherwise the closest scope does", () => {
  const org = asset("review", "org", "acme");
  const team = asset("review", "team", "web");
  const dev = asset("review", "dev", "john");
  assert.equal(findClash([org, team], {})?.installed.id, team.id);
  assert.equal(findClash([org, dev, team], {})?.installed.id, dev.id);
  const installedOrg = { ...org, installed: true };
  assert.equal(findClash([installedOrg, dev], {})?.installed.id, org.id);
  assert.equal(findClash([org, { ...team, kind: "mcp" }], {}), undefined);
});

test("without a terminal the newcomer is skipped and nothing is persisted", async () => {
  const kept = asset("review", "dev", "john", true);
  const incoming = asset("review", "team", "web");
  const outcome = await resolveClashes([kept, incoming], {});
  assert.deepEqual(outcome.localNames, {});
  assert.deepEqual(outcome.disabledAssetIds, []);
  assert.equal(outcome.skipped[0]?.incoming.id, incoming.id);
});

test("each clash choice persists as a rename or a disable", async () => {
  const kept = asset("review", "dev", "john", true);
  const incoming = asset("review", "team", "web");
  const run = (choice: Parameters<typeof resolveClashes>[2]) =>
    resolveClashes([kept, incoming], {}, choice);
  assert.deepEqual((await run(async () => "rename-incoming")).localNames, {
    [incoming.id]: "team-web-review",
  });
  assert.deepEqual((await run(async () => "rename-installed")).localNames, {
    [kept.id]: "dev-john-review",
  });
  assert.deepEqual((await run(async () => "skip-incoming")).disabledAssetIds, [
    incoming.id,
  ]);
  assert.deepEqual(
    (await run(async () => "replace-installed")).disabledAssetIds,
    [kept.id],
  );
  // Local folder Skills cannot be renamed; the choice falls back to skipping.
  const local = { ...kept, renamable: false };
  assert.deepEqual(
    (
      await resolveClashes(
        [local, incoming],
        {},
        async () => "rename-installed",
      )
    ).disabledAssetIds,
    [incoming.id],
  );
});

test("automatic renames are restored once the clash is gone; explicit names stay", () => {
  const team = asset("review", "team", "web");
  const other = asset("lint", "org", "acme");
  assert.deepEqual(restoreNames([team], { [team.id]: "team-web-review" }), {});
  assert.deepEqual(restoreNames([team], { [team.id]: "my-review" }), {
    [team.id]: "my-review",
  });
  const org = asset("review", "org", "acme");
  assert.deepEqual(
    restoreNames([team, org, other], { [team.id]: "team-web-review" }),
    { [team.id]: "team-web-review" },
  );
});

test("renamed Skills rewrite only the frontmatter name", () => {
  const [entry] = renameSkillEntries(
    [
      {
        path: "SKILL.md",
        data: Buffer.from(
          "---\nname: review\ndescription: Review code\n---\n# name: keep\n",
        ),
        executable: false,
      },
    ],
    "team-web-review",
  );
  assert.equal(
    entry!.data.toString(),
    "---\nname: team-web-review\ndescription: Review code\n---\n# name: keep\n",
  );
});

test("installed folders update file by file without replacing the folder", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "barndog-mirror-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "review");
  await mkdir(join(target, "old"), { recursive: true });
  await writeFile(join(target, "SKILL.md"), "v1");
  await writeFile(join(target, "old", "gone.md"), "x");
  const before = (await stat(target)).ino;
  await mirrorTree(target, [
    { path: "SKILL.md", data: Buffer.from("v2"), executable: false },
    {
      path: "scripts/run.sh",
      data: Buffer.from("#!/bin/sh"),
      executable: true,
    },
  ]);
  assert.equal((await stat(target)).ino, before);
  assert.deepEqual(
    (await readTree(target)).map((e) => [
      e.path,
      e.data.toString(),
      e.executable,
    ]),
    [
      ["SKILL.md", "v2", false],
      ["scripts/run.sh", "#!/bin/sh", true],
    ],
  );
});

test("a folder in an installed package can become a file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "barndog-mirror-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "review");
  await mkdir(join(target, "docs", "nested"), { recursive: true });
  await writeFile(join(target, "docs", "nested", "a.md"), "x");
  await mirrorTree(target, [
    { path: "docs", data: Buffer.from("file"), executable: false },
  ]);
  assert.deepEqual(
    (await readTree(target)).map((e) => e.path),
    ["docs"],
  );
});

test("a journal can't restore a kept folder that has vanished", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "barndog-kept-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(installedRoot(home, "skill"), "gone");
  await mkdir(join(home, ".barndog"), { recursive: true });
  await writeFile(
    join(home, ".barndog", "pending-sync.json"),
    JSON.stringify({
      version: 1,
      writes: [
        {
          kind: "tree",
          path,
          before: null,
          after: "kept",
          source: path,
          rename: null,
        },
      ],
    }),
  );
  assert.equal(await recover(home), true);
  await assert.rejects(stat(join(home, ".barndog", "pending-sync.json")));
});

test("every Hook gets its own folder", () => {
  const hook = (
    id: string,
    name: string,
    slug: string,
    extra: { kept?: string; current?: string } = {},
  ) => ({ id, name, origin: { type: "team", slug }, ...extra });
  const folders = (...hooks: ReturnType<typeof hook>[]) => {
    const result = hookFolders(hooks, {});
    return hooks.map((item) => result.get(item.id));
  };
  assert.deepEqual(
    folders(
      hook("aaaaaaaa-1", "b-c", "a"),
      hook("bbbbbbbb-2", "c", "a-b"),
      hook("cccccccc-3", "solo", "web"),
    ),
    ["team-a-b-c-aaaaaaaa", "team-a-b-c-bbbbbbbb", "team-web-solo"],
  );
  // A kept folder and the Hook already installed there don't move for a newcomer.
  assert.deepEqual(
    folders(
      hook("aaaaaaaa-1", "b-c", "a", { kept: "team-a-b-c" }),
      hook("bbbbbbbb-2", "c", "a-b"),
    ),
    ["team-a-b-c", "team-a-b-c-bbbbbbbb"],
  );
  assert.deepEqual(
    folders(
      hook("bbbbbbbb-2", "c", "a-b", { current: "team-a-b-c" }),
      hook("aaaaaaaa-1", "b-c", "a"),
    ),
    ["team-a-b-c", "team-a-b-c-aaaaaaaa"],
  );
  // A Hook literally named like another's suffix keeps every folder distinct.
  const crowded = folders(
    hook("aaaaaaaa-1", "b-c", "a"),
    hook("bbbbbbbb-2", "c", "a-b"),
    hook("dddddddd-4", "b-c-aaaaaaaa", "a"),
  );
  assert.equal(new Set(crowded).size, 3);
  assert.equal(crowded[2], "team-a-b-c-aaaaaaaa");
  // IDs that share their first characters still separate.
  const twins = folders(
    hook("aaaaaaaa-1", "b-c", "a"),
    hook("aaaaaaaa-2", "c", "a-b"),
  );
  assert.equal(new Set(twins).size, 2);
  // Allocating again from what's installed moves nothing, fallback folders included.
  const again = folders(
    hook("aaaaaaaa-1", "b-c", "a", { current: twins[0]! }),
    hook("aaaaaaaa-2", "c", "a-b", { current: twins[1]! }),
  );
  assert.deepEqual(again, twins);
});

test("an invalid asset's automatic name survives restoring names", () => {
  const kept: NamedAsset = {
    id: "1",
    kind: "skill",
    name: "review",
    origin: { type: "org", slug: "org" },
    installed: true,
    renamable: false,
  };
  assert.deepEqual(restoreNames([kept], { "1": "org-org-review" }), {
    "1": "org-org-review",
  });
});

test("tables align styled cells and shrink the flexible column to fit", () => {
  const lines = table(
    [
      [
        "\u001b[1mreview\u001b[22m",
        "org",
        "A long description that will not fit",
      ],
      ["lint", "team/web", "Short"],
    ],
    { header: ["Name", "Origin", "Description"], width: 40 },
  ).map((line) => stripVTControlCharacters(line));
  assert.ok(lines.every((line) => line.length <= 40));
  assert.equal(lines[1]!.indexOf("org"), lines[2]!.indexOf("team/web"));
  assert.match(lines[1]!, /…$/);
});

test("sync resolves MCP name clashes, persists renames and restores the plain name", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "barndog-clash-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const org = randomUUID();
  const developer = randomUUID();
  const team = randomUUID();
  const context = {
    organization: { id: org, name: "Acme", slug: "acme" },
    developer: {
      id: developer,
      name: "Alice",
      slug: "alice",
      role: "developer" as const,
    },
  };
  const mcp = (origin: { type: string; id: string; slug: string }) => {
    const id = randomUUID();
    const versionId = randomUUID();
    return {
      id,
      organizationId: org,
      name: "docs",
      origin,
      createdBy: developer,
      createdAt: new Date().toISOString(),
      distributions: [],
      version: {
        id: versionId,
        mcpId: id,
        number: 1,
        publishedBy: developer,
        publishedAt: new Date().toISOString(),
        definition: {
          transport: "http",
          url: `https://example.com/${origin.slug}`,
          description: "Docs",
          authentication: "none",
          headers: {},
        },
      },
    };
  };
  const orgDocs = mcp({ type: "org", id: org, slug: "acme" });
  const teamDocs = mcp({ type: "team", id: team, slug: "web" });
  let published = [orgDocs, teamDocs];
  const token = "t".repeat(43);
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const send = (value: unknown) => res.end(JSON.stringify(value));
    if (req.url === "/v1/context") return send(context);
    if (req.url === "/v1/environment/catalog")
      return send({
        assets: published.map((m) => ({
          id: m.id,
          kind: "mcp",
          name: m.name,
          origin: m.origin,
          publishedVersion: m.version.id,
        })),
        distributions: [],
      });
    const found = published.find((m) => req.url === `/v1/mcps/${m.id}`);
    if (found) return send(found);
    res.statusCode = 404;
    send({ code: "NOT_FOUND", message: req.url });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await updateCredentials(home, (credentials) => {
    credentials.selectedServer = url;
    credentials.servers[url] = {
      token,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      context,
    };
  });
  const settings: SettingsV2 = {
    version: 2,
    harnesses: ["claude"],
    skills: [],
    knowledge: false,
    connection: { server: url, organizationId: org, developerId: developer },
    environment: {
      subscriptions: [],
      individualAssetIds: [orgDocs.id, teamDocs.id],
      excludedAssetIds: [],
      disabledAssetIds: [],
    },
  };
  await saveSettings(settings, home);
  const servers = async () =>
    Object.keys(
      parseJson(await readFile(join(home, ".claude.json"), "utf8")).mcpServers,
    );

  const skipped = await synchronize(undefined, home, undefined, {
    prompt: false,
  });
  const clash = skipped.find((e) => e.type === "clash");
  assert.ok(clash && clash.type === "clash");
  // The team is the closer scope, so it keeps the name.
  assert.equal(clash.skipped.origin, "org");
  assert.deepEqual(await servers(), ["docs"]);
  assert.equal(
    ((await readSettings(home)) as SettingsV2).localNames,
    undefined,
  );
  const text = stripVTControlCharacters(renderSyncOutput(skipped).join("\n"));
  assert.match(text, /barndog mcp rename docs --origin org --as org-acme-docs/);

  await synchronize(undefined, home, undefined, {
    resolveClash: async () => "rename-incoming",
  });
  assert.deepEqual((await servers()).sort(), ["docs", "org-acme-docs"]);
  assert.deepEqual(((await readSettings(home)) as SettingsV2).localNames, {
    [orgDocs.id]: "org-acme-docs",
  });

  // The team server goes away; the organization server gets its plain name back.
  published = [orgDocs];
  await saveSettings(
    {
      ...((await readSettings(home)) as SettingsV2),
      environment: {
        ...settings.environment!,
        individualAssetIds: [orgDocs.id],
      },
    },
    home,
  );
  const restored = await synchronize(undefined, home, undefined, {
    prompt: false,
  });
  assert.deepEqual(await servers(), ["docs"]);
  // Knowledge is off here, so no session-start index is registered.
  assert.ok(
    !restored.some((e) => e.type === "native" && e.kind === "knowledge"),
  );
  await saveSettings(
    { ...((await readSettings(home)) as SettingsV2), knowledge: true },
    home,
  );
  const withKnowledge = await synchronize(undefined, home, undefined, {
    prompt: false,
  });
  assert.ok(
    withKnowledge.some(
      (e) =>
        e.type === "native" &&
        e.kind === "knowledge" &&
        e.action === "installed",
    ),
  );
  assert.match(
    await readFile(join(home, ".claude", "settings.json"), "utf8"),
    /knowledge\/startup\.js/,
  );
  assert.equal(
    ((await readSettings(home)) as SettingsV2).localNames,
    undefined,
  );
});

test("installed folders are journaled and an interrupted copy is completed on recovery", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "barndog-tree-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = join(home, "cache", "review");
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, "SKILL.md"),
    "---\nname: review\ndescription: Review\n---\n",
  );
  const path = join(installedRoot(home, "skill"), "team-web-review");
  const after = packageFingerprint(
    await desiredEntries(source, "team-web-review"),
  );
  const write = {
    kind: "tree" as const,
    path,
    before: null,
    after,
    source,
    rename: "team-web-review",
  };
  await transact(home, [write]);
  assert.match(
    await readFile(join(path, "SKILL.md"), "utf8"),
    /name: team-web-review/,
  );
  // Simulate a crash midway through an update, then recover from the journal.
  await writeFile(join(path, "partial.tmp"), "half written");
  await writeFile(
    join(home, ".barndog", "pending-sync.json"),
    JSON.stringify({ version: 1, writes: [{ ...write, before: "old" }] }),
  );
  assert.equal(await recover(home), true);
  assert.deepEqual(
    (await readTree(path)).map((e) => e.path),
    ["SKILL.md"],
  );
});

test("cache pruning keeps only the versions installed folders use", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "barndog-prune-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const conn = {
    server: "https://barndog.example.com",
    organizationId: randomUUID(),
    developerId: randomUUID(),
  };
  const root = cacheRoot(cacheKey(conn), home);
  const skill = randomUUID();
  const gone = randomUUID();
  const hook = randomUUID();
  const current = join(root, skill, "a".repeat(40));
  const old = join(root, skill, "b".repeat(40));
  const removedAsset = join(root, gone, "c".repeat(40));
  const hookCurrent = join(root, "hooks", hook, "d".repeat(40));
  const other = join(home, ".barndog", "packages", "other-server", "x", "y");
  for (const path of [current, old, removedAsset, hookCurrent, other])
    await mkdir(join(path, "pkg"), { recursive: true });
  await mkdir(join(root, skill, ".stage-leftover"));
  assert.equal(
    await pruneCache(cacheKey(conn), home, new Set([current, hookCurrent])),
    3,
  );
  const exists = (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    );
  assert.equal(await exists(current), true);
  assert.equal(await exists(hookCurrent), true);
  assert.equal(await exists(old), false);
  assert.equal(await exists(join(root, gone)), false);
  assert.equal(await exists(join(root, skill, ".stage-leftover")), false);
  // Another identity's cache is never touched.
  assert.equal(await exists(other), true);
});
