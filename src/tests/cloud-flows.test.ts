import { expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as contract from "@barndog-ai/api-contract";
import { cloud, COMMIT, ID, packageReply, packages } from "./cloud.js";
import { sample } from "./sample.js";
import { HTTP_STATUS } from "../shared/constants.js";
import type { CliError } from "../errors.js";

const text = (content: string) => Buffer.from(content).toString("base64");

test("hooks test runs the chosen command with the native input", async (t) => {
  const server = await cloud(t);
  const input = join(server.home, "input.json");
  await writeFile(input, JSON.stringify({ hook_event_name: "SessionStart" }));
  const run = (...extra: string[]) =>
    server.run([
      "hooks",
      "test",
      "release-notes",
      "--origin",
      "org",
      "--harness",
      "claude",
      "--input",
      input,
      ...extra,
    ]);

  expect(await run()).toContain("checked");
  expect(JSON.parse(await run("--json"))).toMatchObject({ exitCode: 0 });
  expect(await run("--event", "SessionStart", "--handler", "1")).toContain(
    "checked",
  );

  await expect(run("--event", "Stop")).rejects.toThrow(/Choose an event/);
  await expect(run("--handler", "4")).rejects.toThrow(/no command 4/);
  await expect(run("--timeout", "0")).rejects.toThrow();
  await expect(
    server.run([
      "hooks",
      "test",
      "release-notes",
      "--origin",
      "org",
      "--harness",
      "cursor",
      "--input",
      input,
    ]),
  ).rejects.toThrow(/no cursor implementation/);
});

test("sets are installed, toggled and removed against the catalog", async (t) => {
  const server = await cloud(t, { harnesses: ["claude"] });
  const asset = sample(contract.environmentAssetSchema);

  server.respond("GET", "/v1/environment/catalog", {
    assets: [asset],
    distributions: [
      {
        scope: { type: "org", id: ID },
        assets: [{ assetId: ID, mode: "recommended" }],
      },
    ],
  });

  expect(await server.run(["sets", "list"])).toContain("org");
  expect(JSON.parse(await server.run(["sets", "list", "--json"]))).toBeTruthy();
  await server.run(["sets", "install", "org", "--mode", "all"]);
  expect(
    await readFile(
      join(server.home, ".claude/skills/release-notes/SKILL.md"),
      "utf8",
    ),
  ).toContain("release-notes");

  await server.run(["sets", "disable", "org"]);
  await server.run(["sets", "enable", "org"]);
  await server.run([
    "sets",
    "install",
    "org",
    "--mode",
    "recommended",
    "--overrides",
    "clear",
  ]);

  await server.run(["sets", "remove", "org", "--json"]);
  await expect(
    readFile(join(server.home, ".claude/skills/release-notes/SKILL.md")),
  ).rejects.toThrow();

  await expect(server.run(["sets", "install", "org"])).rejects.toThrow(
    /--mode/,
  );

  await expect(server.run(["sets", "install"])).rejects.toThrow();
});

test("knowledge is listed at session start until it is disabled", async (t) => {
  const server = await cloud(t, { harnesses: ["claude", "cursor"] });
  const settings = () =>
    readFile(join(server.home, ".claude/settings.json"), "utf8");

  await server.run(["sync"]);
  expect(await settings()).toContain("knowledge-startup.js");
  expect(await server.run(["knowledge", "disable"])).toContain("no longer");
  expect(await settings()).not.toContain("knowledge-startup.js");
  await server.run(["knowledge", "enable", "--json"]);
  expect(await settings()).toContain("knowledge-startup.js");
  expect(await server.run(["sync", "--verbose"])).toBeTruthy();
  expect(await server.run(["sync", "--dry-run", "--json"])).toBeTruthy();
});

test("mcp auth points Cursor users at its settings", async (t) => {
  const server = await cloud(t, { harnesses: ["cursor"] });

  await expect(
    server.run([
      "mcp",
      "auth",
      "release-notes",
      "--origin",
      "org",
      "--harness",
      "cursor",
    ]),
  ).resolves.toBeTruthy();

  server.respond(
    "GET",
    "/v1/mcps/([^/]+)",
    (_: Request, match: RegExpMatchArray) => {
      const mcp = sample(contract.mcpSchema, { id: match[1] });

      return {
        ...mcp,
        version: {
          ...mcp.version,
          definition: {
            transport: "http",
            url: "https://mcp.example.test",
            headers: {},
            description: "Example",
            authentication: "native-oauth",
          },
        },
      };
    },
  );

  await expect(
    server.run([
      "mcp",
      "auth",
      "release-notes",
      "--origin",
      "org",
      "--harness",
      "cursor",
    ]),
  ).rejects.toThrow(/isn't installed/);

  await server.run(["mcp", "install", "release-notes", "--origin", "org"]);
  expect(
    await server.run([
      "mcp",
      "auth",
      "release-notes",
      "--origin",
      "org",
      "--harness",
      "cursor",
    ]),
  ).toContain("Open Cursor");
});

test("a new Skill and Hook are scaffolded, pushed and published", async (t) => {
  for (const group of ["skills", "hooks"] as const) {
    const server = await cloud(t);
    const directory = join(server.home, `new-${group}`);
    const changes = group === "skills" ? "skill-changes" : "hook-changes";
    const merged =
      group === "skills"
        ? sample(contract.changeSchema, { status: "merged" })
        : sample(contract.hookChangeSchema, { status: "merged" });

    await server.run([
      group,
      "create",
      "release-notes",
      "--origin",
      "org",
      "--directory",
      directory,
    ]);

    const cwd = process.cwd();
    process.chdir(directory);
    t.onTestFinished(() => process.chdir(cwd));
    server.respond("POST", `/v1/${changes}/[^/]+/merge`, merged);

    expect(await server.run(["status"])).toBeTruthy();
    expect(await server.run(["status", "--json"])).toBeTruthy();
    await server.run(["push", "--publish"]);
    expect(server.requests).toContain(`POST /v1/${changes}`);
    expect(server.requests).toContain(`POST /v1/${changes}/${ID}/merge`);
    process.chdir(cwd);
  }
});

test("pull merges newly published content and reports a conflict to resolve", async (t) => {
  const server = await cloud(t);
  const directory = join(server.home, "copy");
  const file = join(directory, "SKILL.md");

  await server.run([
    "skills",
    "pull",
    "release-notes",
    "--origin",
    "org",
    "--directory",
    directory,
  ]);

  const cwd = process.cwd();
  process.chdir(directory);
  t.onTestFinished(() => process.chdir(cwd));

  const newer = "b".repeat(40);
  const published = sample(contract.skillSchema);
  server.respond("GET", "/v1/skills/[^/]+", {
    ...published,
    version: {
      ...published.version,
      id: "44444444-4444-4444-8444-444444444444",
      number: 2,
      commit: newer,
    },
  });

  server.respond("GET", "/v1/skills/[^/]+/versions/2/package", () =>
    packageReply(
      [
        {
          path: "SKILL.md",
          content: text(
            "---\nname: release-notes\ndescription: Writes release notes\n---\n\nWrite them carefully.\n",
          ),
          executable: false,
        },
        { path: "notes.md", content: text("More\n"), executable: false },
      ],
      newer,
      server.home,
    ),
  );

  await writeFile(
    file,
    "---\nname: release-notes\ndescription: Writes release notes\n---\n\nWrite them quickly.\n",
  );

  const pulled = await server.run(["pull"]);
  expect(pulled).toContain("SKILL.md");
  expect(await readFile(file, "utf8")).toContain("<<<<<<<");
  expect(await readFile(join(directory, "notes.md"), "utf8")).toBe("More\n");
  await expect(server.run(["push"])).rejects.toThrow(/Resolve the conflicts/);

  await writeFile(
    file,
    "---\nname: release-notes\ndescription: Writes release notes\n---\n\nWrite them well.\n",
  );

  await server.run(["resolve", "SKILL.md"]);
  await server.run(["push"]);
  expect(server.requests).toContain("POST /v1/skill-changes");
});

test("a GitHub-authoritative working copy pushes and pulls through its pull request", async (t) => {
  const server = await cloud(t);
  const directory = join(server.home, "copy");
  const published = sample(contract.skillSchema);

  server.respond("GET", "/v1/git-connections", [
    sample(contract.gitConnectionSchema, {
      assetId: ID,
      kind: "skill",
      authority: "github",
      status: "active",
      syncedCommit: COMMIT,
    }),
  ]);

  await server.run([
    "skills",
    "pull",
    "release-notes",
    "--origin",
    "org",
    "--directory",
    directory,
  ]);

  const cwd = process.cwd();
  process.chdir(directory);
  t.onTestFinished(() => process.chdir(cwd));

  expect(await server.run(["push"])).toBeTruthy();
  await writeFile(
    join(directory, "SKILL.md"),
    "---\nname: release-notes\ndescription: Writes release notes\n---\n\nVia GitHub.\n",
  );

  const pull = sample(contract.gitPullSchema, {
    number: 7,
    head: "b".repeat(40),
    submittedCommit: "b".repeat(40),
    state: "open",
    merged: false,
  });

  server.respond("POST", "/v1/git-connections/[^/]+/pulls", pull);
  server.respond("PUT", "/v1/git-connections/[^/]+/pulls/7/revisions", pull);
  server.respond("GET", "/v1/git-connections/[^/]+/pulls/7", {
    ...sample(contract.gitPullDetailsSchema),
    pull,
  });

  await server.run(["push", "--title", "Through GitHub"]);
  expect(server.requests).toContain(`POST /v1/git-connections/${ID}/pulls`);

  await server.run(["pull"]);
  await writeFile(
    join(directory, "SKILL.md"),
    "---\nname: release-notes\ndescription: Writes release notes\n---\n\nVia GitHub again.\n",
  );

  await server.run(["push", "--publish"]);
  expect(server.requests.slice(-8)).toContain(
    `PUT /v1/git-connections/${ID}/pulls/7/revisions`,
  );

  expect(server.requests).toContain(
    `PUT /v1/git-connections/${ID}/pulls/7/merge`,
  );

  server.respond("GET", "/v1/git-connections/[^/]+/pulls/7", {
    ...sample(contract.gitPullDetailsSchema),
    pull: { ...pull, head: "d".repeat(40), merged: true, state: "closed" },
  });

  server.respond("GET", "/v1/git-connections/[^/]+/pulls/7/package", () =>
    packageReply(packages.skill, "d".repeat(40), server.home),
  );

  server.respond("GET", "/v1/skills/[^/]+", published);
  await server.run(["pull"]);
  expect(server.requests).toContain(
    `GET /v1/git-connections/${ID}/pulls/7/package`,
  );
});

test("commands that need a name or a setup say so instead of prompting", async (t) => {
  const server = await cloud(t);

  for (const args of [
    ["skills", "install"],
    ["skills", "remove"],
    ["skills", "rename"],
    ["skills", "fork"],
    ["hooks", "test", "--harness", "claude", "--input", "x"],
    ["skills", "versions"],
    ["skills", "install", "missing", "--origin", "org"],
    ["skills", "show", "missing", "--origin", "org"],
    ["mcp", "show", "missing", "--origin", "org"],
    ["people", "show", "nobody"],
    ["skills", "changes", "comment", ID, "--revision", "1"],
    [
      "github",
      "connect",
      "release-notes",
      "--origin",
      "org",
      "--installation",
      ID,
      "--repository",
      "bad",
    ],
    ["knowledge", "get", "missing"],
    ["local", "list"],
    ["migrate", "--to", "https://barndog.example"],
  ]) {
    server.respond("GET", "/v1/knowledge/missing", () =>
      Response.json(
        { code: "NOT_FOUND", message: "missing" },
        { status: HTTP_STATUS.notFound },
      ),
    );

    await expect(server.run(args), args.join(" ")).rejects.toThrow();
  }

  await expect(server.run(["validate", server.home])).rejects.toThrow();
});

test("a Hook working copy uploads its asset as hookId", async (t) => {
  const server = await cloud(t);
  const directory = join(server.home, "copy");
  const script = join(directory, "scripts/hook.sh");

  await server.run([
    "hooks",
    "pull",
    "release-notes",
    "--origin",
    "org",
    "--directory",
    directory,
  ]);

  const cwd = process.cwd();
  process.chdir(directory);
  t.onTestFinished(() => process.chdir(cwd));

  await writeFile(script, `${await readFile(script, "utf8")}# edited\n`);
  await server.run(["push"]);
  expect(server.bodies.at(-1)).toMatchObject({ hookId: ID });
  expect(server.bodies.at(-1)).not.toHaveProperty("skillId");
  expect(server.bodies.at(-1)).not.toHaveProperty("assetId");
});

test("root push takes a new folder's kind from its manifest file", async (t) => {
  const server = await cloud(t);
  const folder = join(server.home, "new-hook");
  await mkdir(join(folder, "scripts"), { recursive: true });
  for (const file of packages.hook) {
    await writeFile(
      join(folder, file.path),
      Buffer.from(file.content, "base64"),
    );
  }

  const cwd = process.cwd();
  process.chdir(folder);
  t.onTestFinished(() => process.chdir(cwd));

  await expect(
    server.run(["skills", "push", "--origin", "org"]),
  ).rejects.toThrow(/holds a Hook, not a Skill/);

  await server.run(["push", "--origin", "org"]);
  expect(server.requests).toContain("POST /v1/hook-changes");
  expect(server.requests).not.toContain("POST /v1/skill-changes");

  const empty = join(server.home, "empty");
  await mkdir(empty);
  process.chdir(empty);
  await expect(server.run(["push", "--origin", "org"])).rejects.toThrow(
    /no SKILL.md or hook.yaml/,
  );
});

test("a refusal about a change points at that kind's changes list", async (t) => {
  const server = await cloud(t);
  server.respond("POST", "/v1/hook-changes/[^/]+/merge", () =>
    Response.json(
      { code: "APPROVALS_REQUIRED", message: "APPROVALS_REQUIRED" },
      { status: HTTP_STATUS.conflict },
    ),
  );

  await expect(
    server.run(["hooks", "changes", "merge", ID, "--revision", "1"]),
  ).rejects.toSatisfy(
    (error: CliError) => error.hint === "barndog hooks changes list",
  );
});
