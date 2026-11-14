import { HTTP_STATUS, POSIX_MODE } from "../shared/constants.js";

import { assert, expect, test } from "vitest";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  readdir,
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
  hookFolders,
  type ClashResolver,
  type HookPlacement,
  prefixedName,
  resolveClashes,
  type NamedAsset,
} from "../features/environment/names.js";
import {
  desiredEntries,
  mirrorTree,
  renameSkillEntries,
} from "../features/workspace/installed.js";
import { installedRoot } from "../config/state.js";
import { locked, transact } from "../features/environment/transaction.js";
import { cacheKey, pruneCache } from "../features/workspace/packages.js";
import { packageFingerprint } from "@barndog-ai/api-contract/package";
import { synchronize } from "../features/environment/sync.js";
import {
  readSettings,
  saveSettings,
  type Settings,
} from "../config/settings.js";
import { updateCredentials } from "../features/auth/credentials.js";
import { renderSyncOutput } from "../ui/output.js";
import { table } from "../ui/format.js";

/** Each file under `directory` as [relative path, text, executable], sorted by path. */
async function filesIn(directory: string) {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });

  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        join(entry.parentPath, entry.name)
          .slice(directory.length + 1)
          .replaceAll("\\", "/"),
      )
      .sort()
      .map(async (path) => [
        path,
        await readFile(join(directory, path), "utf8"),
        ((await stat(join(directory, path))).mode &
          POSIX_MODE.executableBits) !==
          0,
      ]),
  );
}

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
  expect(prefixedName(asset("review-checklist", "team", "super-team"))).toBe(
    "team-super-team-review-checklist",
  );

  expect(prefixedName(asset("a--b", "dev", "John_Doe"))).toBe(
    "dev-john-doe-a-b",
  );
});

test("the installed asset keeps its name; otherwise the closest scope does", async () => {
  const org = asset("review", "org", "acme");
  const team = asset("review", "team", "web");
  const dev = asset("review", "dev", "john");
  const keeper = async (assets: NamedAsset[]) =>
    (await resolveClashes(assets, {})).skipped.map(
      (clash) => clash.installed.id,
    );

  expect(await keeper([org, team])).toStrictEqual([team.id]);
  expect(await keeper([org, dev, team])).toStrictEqual([dev.id, dev.id]);
  const installedOrg = { ...org, installed: true };
  expect(await keeper([installedOrg, dev])).toStrictEqual([org.id]);
  expect(await keeper([org, { ...team, kind: "mcp" }])).toStrictEqual([]);
});

test("without a terminal the newcomer is skipped and nothing is persisted", async () => {
  const kept = asset("review", "dev", "john", true);
  const incoming = asset("review", "team", "web");
  const outcome = await resolveClashes([kept, incoming], {});
  expect(outcome.localNames).toStrictEqual({});
  expect(outcome.disabledAssetIds).toStrictEqual([]);
  expect(outcome.skipped[0]?.incoming.id).toBe(incoming.id);
});

test("each clash choice persists as a rename or a disable", async () => {
  const kept = asset("review", "dev", "john", true);
  const incoming = asset("review", "team", "web");
  const run = (choice: ClashResolver) =>
    resolveClashes([kept, incoming], {}, choice);

  expect((await run(async () => "rename-incoming")).localNames).toStrictEqual({
    [incoming.id]: "team-web-review",
  });

  expect((await run(async () => "rename-installed")).localNames).toStrictEqual({
    [kept.id]: "dev-john-review",
  });

  expect(
    (await run(async () => "skip-incoming")).disabledAssetIds,
  ).toStrictEqual([incoming.id]);

  expect(
    (await run(async () => "replace-installed")).disabledAssetIds,
  ).toStrictEqual([kept.id]);

  // Local folder Skills cannot be renamed; the choice falls back to skipping.
  const local = { ...kept, renamable: false };
  expect(
    (
      await resolveClashes(
        [local, incoming],
        {},
        async () => "rename-installed",
      )
    ).disabledAssetIds,
  ).toStrictEqual([incoming.id]);
});

test("automatic renames are restored once the clash is gone; explicit names stay", async () => {
  const team = asset("review", "team", "web");
  const other = asset("lint", "org", "acme");
  const names = async (
    assets: NamedAsset[],
    localNames: Record<string, string>,
  ) => (await resolveClashes(assets, localNames)).localNames;

  expect(await names([team], { [team.id]: "team-web-review" })).toStrictEqual(
    {},
  );

  expect(await names([team], { [team.id]: "my-review" })).toStrictEqual({
    [team.id]: "my-review",
  });

  const org = asset("review", "org", "acme");
  expect(
    await names([team, org, other], { [team.id]: "team-web-review" }),
  ).toStrictEqual({ [team.id]: "team-web-review" });
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

  expect(entry!.data.toString()).toBe(
    "---\nname: team-web-review\ndescription: Review code\n---\n# name: keep\n",
  );
});

test("installed folders update file by file without replacing the folder", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "barndog-mirror-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
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

  expect((await stat(target)).ino).toBe(before);
  expect(await filesIn(target)).toStrictEqual([
    ["SKILL.md", "v2", false],
    ["scripts/run.sh", "#!/bin/sh", true],
  ]);
});

test("a folder in an installed package can become a file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "barndog-mirror-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "review");
  await mkdir(join(target, "docs", "nested"), { recursive: true });
  await writeFile(join(target, "docs", "nested", "a.md"), "x");
  await mirrorTree(target, [
    { path: "docs", data: Buffer.from("file"), executable: false },
  ]);

  expect((await filesIn(target)).map(([path]) => path)).toStrictEqual(["docs"]);
});

test("a journal can't restore a kept folder that has vanished", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "barndog-kept-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
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

  await locked(home, async () => {});
  await expect(
    stat(join(home, ".barndog", "pending-sync.json")),
  ).rejects.toThrow();
});

test("every Hook gets its own folder", () => {
  const hook = (
    id: string,
    name: string,
    slug: string,
    extra: { kept?: string; current?: string } = {},
  ) => ({ id, name, origin: { type: "team", slug }, ...extra });

  const folders = (...hooks: HookPlacement[]) => {
    const result = hookFolders(hooks, {});

    return hooks.map((item) => result.get(item.id));
  };

  expect(
    folders(
      hook("aaaaaaaa-1", "b-c", "a"),
      hook("bbbbbbbb-2", "c", "a-b"),
      hook("cccccccc-3", "solo", "web"),
    ),
  ).toStrictEqual([
    "team-a-b-c-aaaaaaaa",
    "team-a-b-c-bbbbbbbb",
    "team-web-solo",
  ]);

  // A kept folder and the Hook already installed there don't move for a newcomer.
  expect(
    folders(
      hook("aaaaaaaa-1", "b-c", "a", { kept: "team-a-b-c" }),
      hook("bbbbbbbb-2", "c", "a-b"),
    ),
  ).toStrictEqual(["team-a-b-c", "team-a-b-c-bbbbbbbb"]);

  expect(
    folders(
      hook("bbbbbbbb-2", "c", "a-b", { current: "team-a-b-c" }),
      hook("aaaaaaaa-1", "b-c", "a"),
    ),
  ).toStrictEqual(["team-a-b-c", "team-a-b-c-aaaaaaaa"]);

  // A Hook literally named like another's suffix keeps every folder distinct.
  const crowded = folders(
    hook("aaaaaaaa-1", "b-c", "a"),
    hook("bbbbbbbb-2", "c", "a-b"),
    hook("dddddddd-4", "b-c-aaaaaaaa", "a"),
  );

  expect(new Set(crowded).size).toBe(3);
  expect(crowded[2]).toBe("team-a-b-c-aaaaaaaa");
  // IDs that share their first characters still separate.
  const twins = folders(
    hook("aaaaaaaa-1", "b-c", "a"),
    hook("aaaaaaaa-2", "c", "a-b"),
  );

  expect(new Set(twins).size).toBe(2);
  // Allocating again from what's installed moves nothing, fallback folders included.
  const again = folders(
    hook("aaaaaaaa-1", "b-c", "a", { current: twins[0]! }),
    hook("aaaaaaaa-2", "c", "a-b", { current: twins[1]! }),
  );

  expect(again).toStrictEqual(twins);
});

test("an invalid asset's automatic name survives restoring names", async () => {
  const kept: NamedAsset = {
    id: "1",
    kind: "skill",
    name: "review",
    origin: { type: "org", slug: "org" },
    installed: true,
    renamable: false,
  };

  expect(
    (await resolveClashes([kept], { "1": "org-org-review" })).localNames,
  ).toStrictEqual({ "1": "org-org-review" });
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

  expect(lines.every((line) => line.length <= 40)).toBeTruthy();
  expect(lines[1]!.indexOf("org")).toBe(lines[2]!.indexOf("team/web"));
  expect(lines[1]!).toMatch(/…$/);
});

test("sync resolves MCP name clashes, persists renames and restores the plain name", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "barndog-clash-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
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
    if (req.url === "/v1/context") {
      return send(context);
    }

    if (req.url === "/v1/environment/catalog") {
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
    }

    const found = published.find((m) => req.url === `/v1/mcps/${m.id}`);
    if (found) {
      return send(found);
    }

    res.statusCode = HTTP_STATUS.notFound;
    send({ code: "NOT_FOUND", message: req.url });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.onTestFinished(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );

  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await updateCredentials(home, (credentials) => {
    credentials.selectedServer = url;
    credentials.servers[url] = {
      token,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      context,
    };
  });

  const settings: Settings = {
    harnesses: ["claude"],
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
  assert(clash && clash.type === "clash");
  // The team is the closer scope, so it keeps the name.
  expect(clash.skipped.origin).toBe("org");
  expect(await servers()).toStrictEqual(["docs"]);
  expect(((await readSettings(home)) as Settings).localNames).toBe(undefined);
  const text = stripVTControlCharacters(renderSyncOutput(skipped).join("\n"));
  expect(text).toMatch(
    /barndog mcp rename docs --origin org --as org-acme-docs/,
  );

  await synchronize(undefined, home, undefined, {
    resolveClash: async () => "rename-incoming",
  });

  expect((await servers()).sort()).toStrictEqual(["docs", "org-acme-docs"]);
  expect(((await readSettings(home)) as Settings).localNames).toStrictEqual({
    [orgDocs.id]: "org-acme-docs",
  });

  // The team server goes away; the organization server gets its plain name back.
  published = [orgDocs];
  await saveSettings(
    {
      ...((await readSettings(home)) as Settings),
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

  expect(await servers()).toStrictEqual(["docs"]);
  // Knowledge is off here, so no session-start index is registered.
  expect(
    restored.some((e) => e.type === "native" && e.kind === "knowledge"),
  ).toBeFalsy();

  await saveSettings(
    { ...((await readSettings(home)) as Settings), knowledge: true },
    home,
  );

  const withKnowledge = await synchronize(undefined, home, undefined, {
    prompt: false,
  });

  expect(
    withKnowledge.some(
      (e) =>
        e.type === "native" &&
        e.kind === "knowledge" &&
        e.action === "installed",
    ),
  ).toBeTruthy();

  expect(
    await readFile(join(home, ".claude", "settings.json"), "utf8"),
  ).toMatch(/knowledge\/startup\.js/);

  expect(((await readSettings(home)) as Settings).localNames).toBe(undefined);
});

test("installed folders are journaled and an interrupted copy is completed on recovery", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "barndog-tree-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
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
  expect(await readFile(join(path, "SKILL.md"), "utf8")).toMatch(
    /name: team-web-review/,
  );

  // Simulate a crash midway through an update, then recover from the journal.
  await writeFile(join(path, "partial.tmp"), "half written");
  await writeFile(
    join(home, ".barndog", "pending-sync.json"),
    JSON.stringify({ version: 1, writes: [{ ...write, before: "old" }] }),
  );

  await locked(home, async () => {});
  expect((await filesIn(path)).map(([path]) => path)).toStrictEqual([
    "SKILL.md",
  ]);
});

test("cache pruning keeps only the versions installed folders use", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "barndog-prune-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const conn = {
    server: "https://barndog.example.com",
    organizationId: randomUUID(),
    developerId: randomUUID(),
  };

  const root = join(home, ".barndog", "packages", cacheKey(conn));
  const skill = randomUUID();
  const gone = randomUUID();
  const hook = randomUUID();
  const current = join(root, skill, "a".repeat(40));
  const old = join(root, skill, "b".repeat(40));
  const removedAsset = join(root, gone, "c".repeat(40));
  const hookCurrent = join(root, "hooks", hook, "d".repeat(40));
  const other = join(home, ".barndog", "packages", "other-server", "x", "y");
  for (const path of [current, old, removedAsset, hookCurrent, other]) {
    await mkdir(join(path, "pkg"), { recursive: true });
  }

  await mkdir(join(root, skill, ".stage-leftover"));
  expect(
    await pruneCache(cacheKey(conn), home, new Set([current, hookCurrent])),
  ).toBe(3);

  const exists = (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    );

  expect(await exists(current)).toBe(true);
  expect(await exists(hookCurrent)).toBe(true);
  expect(await exists(old)).toBe(false);
  expect(await exists(join(root, gone))).toBe(false);
  expect(await exists(join(root, skill, ".stage-leftover"))).toBe(false);
  // Another identity's cache is never touched.
  expect(await exists(other)).toBe(true);
});
