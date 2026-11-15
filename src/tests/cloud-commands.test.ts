import { expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cloud, COMMIT, HOOK_ID, ID, MCP_ID } from "./cloud.js";

/** Read-only commands: the arguments, and the request each must make. */
const reads: [string[], string][] = [
  [
    ["skills", "versions", "release-notes", "--origin", "org"],
    `GET /v1/skills/${ID}/versions`,
  ],
  [
    ["skills", "show", "release-notes", "--origin", "org"],
    `GET /v1/skills/${ID}/content?version=1`,
  ],
  [
    ["hooks", "versions", "release-notes", "--origin", "org"],
    `GET /v1/hooks/${ID}/versions`,
  ],
  [
    ["hooks", "show", "release-notes", "--origin", "org"],
    `GET /v1/hooks/${ID}/content?version=1`,
  ],
  [
    ["hooks", "compatibility", "release-notes", "--origin", "org"],
    `GET /v1/hooks/${HOOK_ID}`,
  ],
  [
    ["mcp", "show", "release-notes", "--origin", "org"],
    `GET /v1/mcps/${MCP_ID}`,
  ],
  [
    ["mcp", "versions", "release-notes", "--origin", "org"],
    `GET /v1/mcps/${MCP_ID}/versions`,
  ],
  [["skills", "changes", "list"], "GET /v1/skill-changes"],
  [["hooks", "changes", "list"], "GET /v1/hook-changes"],
  [["skills", "changes", "show", ID], `GET /v1/skill-changes/${ID}`],
  [["hooks", "changes", "show", ID], `GET /v1/hook-changes/${ID}`],
  [["skills", "changes", "diff", ID], `GET /v1/skill-changes/${ID}/diff`],
  [["knowledge", "list"], "GET /v1/knowledge?limit=100"],
  [["knowledge", "get", "release-notes"], "GET /v1/knowledge/release-notes"],
  [["people", "list"], "GET /v1/developers?limit=100"],
  [["people", "show", "acme"], `GET /v1/developers/${ID}/assets?limit=100`],
  [
    ["people", "show", "acme", "--search", "notes"],
    `GET /v1/developers/${ID}/assets?limit=100&search=notes`,
  ],
  [
    ["people", "list", "--search", "ali"],
    "GET /v1/developers?limit=100&search=ali",
  ],
  [["open", "--no-browser"], "GET /v1/context"],
  [["doctor"], "GET /v1/context"],
  [["repo", "status"], "GET /v1/repositories"],
  [
    [
      "skills",
      "diff",
      "release-notes",
      "--origin",
      "org",
      "--from",
      "1",
      "--to",
      "2",
    ],
    `GET /v1/skills/${ID}/diff?from=1&to=2`,
  ],
  [
    [
      "hooks",
      "diff",
      "release-notes",
      "--origin",
      "org",
      "--from",
      "1",
      "--to",
      "2",
    ],
    `GET /v1/hooks/${ID}/diff?from=1&to=2`,
  ],
  [["hooks", "changes", "diff", ID], `GET /v1/hook-changes/${ID}/diff`],
  [["mcp", "list"], "GET /v1/environment/catalog"],
  [["hooks", "list", "--available"], "GET /v1/environment/catalog"],
  [["skills", "list", "--paths"], "GET /v1/environment/catalog"],
  [["github", "status"], "GET /v1/github/status"],
  [["github", "installations"], "GET /v1/github/installations"],
  [["github", "list"], "GET /v1/git-connections"],
  [["github", "show", ID], `GET /v1/git-connections/${ID}`],
  [["github", "remote-head", ID], `GET /v1/git-connections/${ID}/remote-head`],
  [["github", "pulls", "list", ID], `GET /v1/git-connections/${ID}/pulls`],
  [
    ["github", "pulls", "show", ID, "7"],
    `GET /v1/git-connections/${ID}/pulls/7`,
  ],
  [["sets", "list"], "GET /v1/scopes"],
  [["whoami"], "GET /v1/context"],
  [["auth", "status"], "GET /v1/context"],
  [["skills", "search"], "GET /v1/skills?limit=100"],
  [["hooks", "search"], "GET /v1/hooks?limit=100"],
  [["mcp", "search"], "GET /v1/mcps?limit=100"],
  [["skills", "list"], "GET /v1/environment/catalog"],
  [["status"], "GET /v1/environment/catalog"],
];

test.for(reads)(
  "%j reads from the server",
  async ([args, request], { task }) => {
    for (const mode of [[], ["--json"]]) {
      const server = await cloud(task.context as never);
      const output = await server.run([...args, ...mode]);

      expect(
        server.requests.filter((sent) => sent === request),
        `${output}\n${server.requests.join("\n")}`,
      ).toHaveLength(args[0] === "doctor" ? 2 : 1);

      expect(output.length, args.join(" ")).toBeGreaterThan(0);
      if (mode.length) {
        const result: unknown = JSON.parse(output);
        expect(result).not.toHaveProperty("error");
        if (args[1] === "versions") {
          expect(result).toMatchObject([
            args[0] === "mcp"
              ? { number: 1, id: ID }
              : { number: 1, commit: COMMIT },
          ]);
        }

        if (
          (args[0] === "skills" || args[0] === "hooks") &&
          args[1] === "show"
        ) {
          expect(result).toMatchObject({
            files: expect.arrayContaining([
              expect.objectContaining({
                path: args[0] === "skills" ? "SKILL.md" : "hook.yaml",
              }),
            ]),
          });
        }
      }
    }
  },
);

const revision = ["--revision", "1"];
const repository = ["--installation", ID, "--repository", "acme/skills"];
const head = ["--expected-commit", COMMIT];

/** Commands that change something on the server: arguments and the request. */
const writes: [string[], string][] = [
  ...(["skills", "hooks"] as const).flatMap((group): [string[], string][] => {
    const route = group === "skills" ? "skill-changes" : "hook-changes";

    return [
      [
        [group, "changes", "approve", ID, ...revision],
        `POST /v1/${route}/${ID}/reviews`,
      ],
      [
        [group, "changes", "request-changes", ID, ...revision],
        `POST /v1/${route}/${ID}/reviews`,
      ],
      [
        [group, "changes", "reject", ID, ...revision],
        `POST /v1/${route}/${ID}/reject`,
      ],
      [
        [group, "changes", "merge", ID, ...revision],
        `POST /v1/${route}/${ID}/merge`,
      ],
      [
        [group, "changes", "comment", ID, ...revision, "--body", "Looks good"],
        `POST /v1/${route}/${ID}/discussions`,
      ],
      [
        [
          group,
          "changes",
          "comment",
          ID,
          ...revision,
          "--body",
          "Agreed",
          "--thread",
          ID,
        ],
        `POST /v1/${route}/${ID}/discussions/${ID}/comments`,
      ],
      [
        [group, "changes", "apply", ID, ID, ...revision],
        `POST /v1/${route}/${ID}/discussions/${ID}/apply`,
      ],
      [
        [group, "changes", "resolve-discussion", ID, ID, ...revision],
        `POST /v1/${route}/${ID}/discussions/${ID}/resolve`,
      ],
      [
        [group, "changes", "reopen-discussion", ID, ID, ...revision],
        `POST /v1/${route}/${ID}/discussions/${ID}/resolve`,
      ],
      [
        [
          group,
          "fork",
          "release-notes",
          "--origin",
          "org",
          "--target",
          "org",
          "--name",
          "notes-copy",
        ],
        `POST /v1/environment/${group === "skills" ? "skill" : "hook"}/${group === "skills" ? ID : HOOK_ID}/fork`,
      ],
      [
        [
          group,
          "promote",
          "release-notes",
          "--origin",
          "org",
          "--target",
          "org",
          "--name",
          "notes-copy",
        ],
        `POST /v1/environment/${group === "skills" ? "skill" : "hook"}/${group === "skills" ? ID : HOOK_ID}/promote`,
      ],
    ];
  }),
  [
    [
      "mcp",
      "fork",
      "release-notes",
      "--origin",
      "org",
      "--target",
      "org",
      "--name",
      "notes-copy",
    ],
    `POST /v1/environment/mcp/${MCP_ID}/fork`,
  ],
  [["github", "auth", "--no-browser"], "POST /v1/github/authorize"],
  [["github", "install", "--no-browser"], "POST /v1/github/install"],
  [
    ["github", "connect", "release-notes", "--origin", "org", ...repository],
    "POST /v1/git-connections",
  ],
  [
    [
      "github",
      "connect",
      "release-notes",
      "--kind",
      "hook",
      "--origin",
      "org",
      ...repository,
      "--mode",
      "mirror",
    ],
    "POST /v1/git-connections",
  ],
  [
    ["github", "import", "release-notes", "--origin", "org", ...repository],
    "POST /v1/git-connections/import",
  ],
  [
    [
      "github",
      "import",
      "release-notes",
      "--origin",
      "org",
      ...repository,
      "--authority",
      "barndog",
      "--key",
      "k1",
    ],
    "POST /v1/git-connections/import-copy",
  ],
  [
    [
      "github",
      "create-repository",
      "release-notes",
      "--origin",
      "org",
      ...repository,
      "--key",
      "k1",
      "--expected-version",
      ID,
    ],
    "POST /v1/git-connections/create-repository",
  ],
  [["github", "sync", ID], `POST /v1/git-connections/${ID}/sync`],
  [
    [
      "github",
      "resolve-mirror",
      ID,
      "--action",
      "use-barndog",
      "--expected-version",
      ID,
      "--expected-remote",
      COMMIT,
    ],
    `POST /v1/git-connections/${ID}/mirror-resolution`,
  ],
  [
    [
      "github",
      "resolve-mirror",
      ID,
      "--action",
      "disconnect",
      "--expected-version",
      ID,
      "--expected-remote",
      "absent",
    ],
    `POST /v1/git-connections/${ID}/mirror-resolution`,
  ],
  [
    [
      "github",
      "pulls",
      "review",
      ID,
      "7",
      ...head,
      "--event",
      "APPROVE",
      "--body",
      "Fine",
    ],
    "POST /v1/git-connections/" + ID + "/pulls/7/reviews",
  ],
  [
    [
      "github",
      "pulls",
      "comment",
      ID,
      "7",
      ...head,
      "--body",
      "Nit",
      "--path",
      "SKILL.md",
      "--line",
      "3",
      "--side",
      "RIGHT",
    ],
    `POST /v1/git-connections/${ID}/pulls/7/comments`,
  ],
  [
    ["github", "pulls", "merge", ID, "7", ...head],
    "PUT /v1/git-connections/" + ID + "/pulls/7/merge",
  ],
];

function expectedBody(args: string[]): unknown {
  if (args[1] === "changes") {
    const bodies: Record<string, unknown> = {
      approve: { expectedRevision: 1, decision: "approve" },
      "request-changes": { expectedRevision: 1, decision: "request_changes" },
      reject: { expectedRevision: 1 },
      merge: { expectedRevision: 1 },
      comment: {
        expectedRevision: 1,
        body: args.includes("--thread") ? "Agreed" : "Looks good",
      },
      apply: { expectedRevision: 1 },
      "resolve-discussion": { expectedRevision: 1, resolved: true },
      "reopen-discussion": { expectedRevision: 1, resolved: false },
    };

    expect(bodies).toHaveProperty(args[2]!);

    return bodies[args[2]!];
  }

  if (args[1] === "fork" || args[1] === "promote") {
    return {
      origin: { type: "org", id: ID },
      name: "notes-copy",
      idempotencyKey: expect.any(String),
    };
  }

  const target = {
    kind: "skill",
    installationId: ID,
    owner: "acme",
    repository: "skills",
  };

  const bodies: Record<string, unknown> = {
    auth: undefined,
    install: undefined,
    connect: {
      ...target,
      kind: args.includes("hook") ? "hook" : "skill",
      assetId: args.includes("hook") ? HOOK_ID : ID,
      expectedVersionId: ID,
      mode: args.includes("mirror") ? "mirror" : "connect",
    },
    import: {
      ...target,
      name: "release-notes",
      origin: { type: "org", id: ID },
      ...(args.includes("barndog") ? { idempotencyKey: "k1" } : {}),
    },
    "create-repository": {
      ...target,
      assetId: ID,
      expectedVersionId: ID,
      mode: "mirror",
      visibility: "private",
      idempotencyKey: "k1",
    },
    sync: undefined,
    "resolve-mirror": {
      action: args.includes("disconnect") ? "disconnect" : "use-barndog",
      expectedVersionId: ID,
      expectedRemoteCommit: args.includes("absent") ? null : COMMIT,
      idempotencyKey: expect.any(String),
    },
    review: { expectedCommit: COMMIT, event: "APPROVE", body: "Fine" },
    comment: {
      expectedCommit: COMMIT,
      body: "Nit",
      path: "SKILL.md",
      line: 3,
      side: "RIGHT",
    },
    merge: { expectedCommit: COMMIT },
  };

  const action = args[1] === "pulls" ? args[2]! : args[1]!;
  expect(bodies).toHaveProperty(action);

  return bodies[action];
}

test.for(writes)(
  "%j writes to the server",
  async ([args, request], { task }) => {
    for (const mode of [[], ["--json"]]) {
      const server = await cloud(task.context as never);
      const output = await server.run([...args, ...mode]);

      const sent = server.sent.filter((entry) => entry.request === request);
      expect(sent, output).toHaveLength(1);
      expect(sent[0]?.body).toEqual(expectedBody(args));
      expect(
        server.sent.filter((entry) => !entry.request.startsWith("GET ")),
      ).toHaveLength(1);

      if (mode.length) {
        const result: unknown = JSON.parse(output);
        expect(result).toBeTruthy();
        expect(result).not.toHaveProperty("error");
        if (args[1] === "changes") {
          expect(result).toMatchObject({ id: ID, revision: 1 });
        }
      }

      expect(output.length, args.join(" ")).toBeGreaterThan(0);
    }
  },
);

test("a GitHub pull request is opened and revised with the whole package", async (t) => {
  const server = await cloud(t);
  const directory = join(server.home, "package");
  await mkdir(directory);
  await writeFile(
    join(directory, "SKILL.md"),
    "---\nname: release-notes\n---\n",
  );

  const body = join(server.home, "body.md");
  await writeFile(body, "Longer explanation");

  await server.run([
    "github",
    "pulls",
    "create",
    ID,
    ...head,
    "--title",
    "Update",
    "--directory",
    directory,
    "--body-file",
    body,
  ]);

  await server.run([
    "github",
    "pulls",
    "revise",
    ID,
    "7",
    ...head,
    "--directory",
    directory,
    "--key",
    "retry-1",
  ]);

  expect(server.requests).toContain(`POST /v1/git-connections/${ID}/pulls`);
  expect(server.requests).toContain(
    `PUT /v1/git-connections/${ID}/pulls/7/revisions`,
  );

  expect(server.bodies).toMatchObject([
    {
      title: "Update",
      body: "Longer explanation",
      expectedCommit: COMMIT,
      files: [{ path: "SKILL.md" }],
    },
    { idempotencyKey: "retry-1", files: [{ path: "SKILL.md" }] },
  ]);
});

test("an MCP configuration is published and revised from a JSON file", async (t) => {
  const server = await cloud(t);
  const file = join(server.home, "server.json");
  await writeFile(
    file,
    JSON.stringify({
      transport: "http",
      url: "https://mcp.example.test",
      headers: { Authorization: { secretRef: "EXAMPLE_TOKEN" } },
      description: "Example",
      authentication: "environment",
    }),
  );

  await server.run([
    "mcp",
    "create",
    "example",
    "--origin",
    "org",
    "--file",
    file,
    "--key",
    "k1",
  ]);

  await server.run([
    "mcp",
    "update",
    "release-notes",
    "--origin",
    "org",
    "--file",
    file,
    "--expected-version",
    ID,
  ]);

  expect(server.requests).toContain("POST /v1/mcps");
  expect(server.requests).toContain(`POST /v1/mcps/${MCP_ID}/versions`);
  expect(server.bodies).toMatchObject([
    {
      name: "example",
      idempotencyKey: "k1",
      definition: { transport: "http" },
    },
    { expectedVersionId: ID },
  ]);
});

test("installing from Cloud delivers a Skill, a Hook and an MCP server to Claude Code", async (t) => {
  const server = await cloud(t, { harnesses: ["claude"] });

  for (const group of ["skills", "hooks", "mcp"]) {
    await server.run([group, "install", "release-notes", "--origin", "org"]);
  }

  const skill = await readFile(
    join(server.home, ".claude/skills/release-notes/SKILL.md"),
    "utf8",
  );

  expect(skill).toContain("Write them.");
  expect(
    await readFile(join(server.home, ".claude/settings.json"), "utf8"),
  ).toContain("scripts/hook.sh");

  expect(await readFile(join(server.home, ".claude.json"), "utf8")).toContain(
    "release-notes",
  );

  expect(server.requests).toContain(`GET /v1/skills/${ID}/versions/1/package`);
  expect(server.requests).toContain(
    `GET /v1/hooks/${HOOK_ID}/versions/1/package`,
  );

  const listed = await server.run(["skills", "list", "--installed", "--paths"]);
  expect(listed).toContain("release-notes");

  await server.run(["skills", "disable", "release-notes", "--origin", "org"]);
  await server.run(["skills", "enable", "release-notes", "--origin", "org"]);
  await server.run([
    "skills",
    "rename",
    "release-notes",
    "--origin",
    "org",
    "--as",
    "notes",
  ]);

  expect(
    await readFile(join(server.home, ".claude/skills/notes/SKILL.md"), "utf8"),
  ).toContain("name: notes");

  await server.run(["skills", "rename", "notes", "--origin", "org", "--reset"]);
  for (const group of ["skills", "hooks", "mcp"]) {
    await server.run([group, "remove", "release-notes", "--origin", "org"]);
  }

  expect(
    await readFile(join(server.home, ".claude.json"), "utf8"),
  ).not.toContain("release-notes");
});

test("a Cloud working copy is pulled, edited, pushed and merged", async (t) => {
  for (const group of ["skills", "hooks"] as const) {
    const server = await cloud(t);
    const directory = join(server.home, `copy-${group}`);
    const file = group === "skills" ? "SKILL.md" : "scripts/hook.sh";
    const changes = group === "skills" ? "skill-changes" : "hook-changes";

    await server.run([
      group,
      "pull",
      "release-notes",
      "--origin",
      "org",
      "--directory",
      directory,
    ]);

    await writeFile(
      join(directory, file),
      `${await readFile(join(directory, file), "utf8")}\n# edited\n`,
    );

    const cwd = process.cwd();
    process.chdir(directory);
    t.onTestFinished(() => process.chdir(cwd));

    expect(await server.run(["status"])).toContain(file);
    expect(await server.run(["diff"])).toContain("edited");
    await server.run(["push", "--title", "Edit it"]);
    expect(server.requests).toContain(`POST /v1/${changes}`);
    await server.run(["pull"]);
    await server.run(["push", "--json"]);
    process.chdir(cwd);
  }
});
