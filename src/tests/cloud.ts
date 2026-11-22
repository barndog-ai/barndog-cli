/**
 * A fake BarnDog server for tests that run real commands and features against
 * a Cloud workspace. Responses are built from the contract's own schemas, so a
 * fixture can't drift from what the server sends. Every UUID is `ID`, which
 * makes the organization, developer, scopes and assets line up without setup.
 */
import { testRuntime } from "./runtime.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { z } from "zod";
import * as contract from "@barndog-ai/api-contract";

import { saveSettings, type Settings } from "../config/settings.js";
import { updateCredentials } from "../features/auth/credentials.js";
import { archive } from "../features/collaboration/workspace.js";
import { createProgram, type ProgramOptions } from "../program.js";
import { sample } from "./sample.js";

type TestContext = import("vitest").TestContext;

export const ID = "11111111-1111-4111-8111-111111111111";

export const HOOK_ID = "22222222-2222-4222-8222-222222222222";

export const MCP_ID = "33333333-3333-4333-8333-333333333333";

const SERVER = "http://127.0.0.1:9";

export const COMMIT = "a".repeat(40);

const base64 = (text: string) => Buffer.from(text).toString("base64");

/** The files of the published Skill and Hook the fake server hands out. */
export const packages = {
  skill: [
    {
      path: "SKILL.md",
      content: base64(
        "---\nname: release-notes\ndescription: Writes release notes\n---\n\nWrite them.\n",
      ),
      executable: false,
    },
  ],
  hook: [
    {
      path: "hook.yaml",
      content: base64(
        [
          "name: release-notes",
          "description: Checks release notes",
          "implementations:",
          "  claude:",
          "    compatibility: supported",
          "    scripts: [scripts/hook.sh]",
          "    requirements:",
          "      commands: [sh]",
          "    events:",
          "      SessionStart:",
          "        - hooks:",
          "            - type: command",
          "              command: '${BARNDOG_HOOK_ROOT}/scripts/hook.sh'",
          "",
        ].join("\n"),
      ),
      executable: false,
    },
    {
      path: "scripts/hook.sh",
      content: base64("#!/bin/sh\necho checked\n"),
      executable: true,
    },
  ],
};

type Reply = unknown | ((request: Request, match: RegExpMatchArray) => unknown);

type Route = { method: string; path: RegExp; reply: Reply };

const page = <T extends z.ZodType>(schema: T) =>
  sample(schema, { nextCursor: null });

const change = () =>
  sample(contract.changeSchema, { status: "open", publishedVersion: null });

const hookChange = () =>
  sample(contract.hookChangeSchema, { status: "open", publishedVersion: null });

/** The schema's sample under the ID the request asked for. */
const byId =
  (schema: z.ZodType) =>
  (_: Request, match: RegExpMatchArray): unknown =>
    sample(schema, { id: match[1] });

/** One published asset of each kind, all in the organization scope. */
function catalog() {
  const asset = sample(contract.environmentAssetSchema);

  return contract.environmentCatalogSchema.parse({
    assets: [
      { ...asset, kind: "skill", id: ID },
      { ...asset, kind: "hook", id: HOOK_ID },
      { ...asset, kind: "mcp", id: MCP_ID },
    ],
    distributions: [],
  });
}

/** What every route answers unless a test replaces it with `respond()`. */
function defaultRoutes(home: string): Route[] {
  const download = async (kind: keyof typeof packages) =>
    new Response(await archive(packages[kind], testRuntime(home)), {
      headers: { etag: `"${COMMIT}"` },
    });

  const routes: [string, string, Reply][] = [
    ["GET", "/v1/context", sample(contract.contextSchema)],
    [
      "DELETE",
      "/v1/auth/cli/session",
      () => new Response(null, { status: 204 }),
    ],
    ["GET", "/v1/scopes", [sample(contract.scopeSchema)]],
    ["GET", "/v1/organization/members", [sample(contract.memberSchema)]],
    ["GET", "/v1/teams", [sample(contract.teamSchema)]],
    ["GET", "/v1/teams/[^/]+/members", [sample(contract.teamMemberSchema)]],
    ["GET", "/v1/repositories", [sample(contract.repositorySchema)]],
    ["GET", "/v1/environment/catalog", catalog()],
    [
      "GET",
      "/v1/environment/catalog/revision",
      sample(contract.environmentCatalogRevisionSchema),
    ],
    [
      "POST",
      "/v1/environment/[^/]+/[^/]+/(promote|fork)",
      { kind: "skill", id: ID, changeId: ID },
    ],

    ["GET", "/v1/skills", page(contract.listOutputSchema)],
    ["GET", "/v1/skills/([^/]+)", byId(contract.skillSchema)],
    ["GET", "/v1/skills/[^/]+/versions", [sample(contract.versionSchema)]],
    ["GET", "/v1/skills/[^/]+/content", { files: packages.skill }],
    ["GET", "/v1/skills/[^/]+/diff", [sample(contract.fileDiffSchema)]],
    ["GET", "/v1/skills/[^/]+/versions/\\d+/package", () => download("skill")],

    ["GET", "/v1/hooks", page(contract.hookListSchema)],
    ["GET", "/v1/hooks/([^/]+)", byId(contract.hookSchema)],
    ["GET", "/v1/hooks/[^/]+/versions", [sample(contract.hookVersionSchema)]],
    ["GET", "/v1/hooks/[^/]+/content", { files: packages.hook }],
    ["GET", "/v1/hooks/[^/]+/diff", [sample(contract.fileDiffSchema)]],
    [
      "GET",
      "/v1/hooks/[^/]+/compatibility",
      sample(contract.hookCompatibilityResponseSchema),
    ],
    ["GET", "/v1/hooks/[^/]+/versions/\\d+/package", () => download("hook")],

    ["GET", "/v1/mcps", page(contract.mcpListSchema)],
    ["POST", "/v1/mcps", sample(contract.mcpSchema)],
    ["GET", "/v1/mcps/([^/]+)", byId(contract.mcpSchema)],
    ["GET", "/v1/mcps/[^/]+/versions", [sample(contract.mcpVersionSchema)]],
    ["POST", "/v1/mcps/[^/]+/versions", sample(contract.mcpSchema)],

    ["GET", "/v1/skill-changes", { changes: [change()], nextCursor: null }],
    ["GET", "/v1/skill-changes/[^/]+/diff", [sample(contract.fileDiffSchema)]],
    ["GET", "/v1/skill-changes/[^/]+/package", () => download("skill")],
    ["POST", "/v1/skill-changes", change],
    ["GET", "/v1/skill-changes/[^/]+", change],
    ["PUT", "/v1/skill-changes/[^/]+/revisions", change],
    ["POST", "/v1/skill-changes/[^/]+/reviews", change],
    ["POST", "/v1/skill-changes/[^/]+/reject", change],
    ["POST", "/v1/skill-changes/[^/]+/merge", change],
    ["POST", "/v1/skill-changes/[^/]+/discussions", change],
    ["POST", "/v1/skill-changes/[^/]+/discussions/[^/]+/comments", change],
    ["POST", "/v1/skill-changes/[^/]+/discussions/[^/]+/resolve", change],
    ["POST", "/v1/skill-changes/[^/]+/discussions/[^/]+/apply", change],
    ["GET", "/v1/hook-changes", { changes: [hookChange()], nextCursor: null }],
    ["GET", "/v1/hook-changes/[^/]+/diff", [sample(contract.fileDiffSchema)]],
    ["GET", "/v1/hook-changes/[^/]+/package", () => download("hook")],
    ["POST", "/v1/hook-changes", hookChange],
    ["GET", "/v1/hook-changes/[^/]+", hookChange],
    ["PUT", "/v1/hook-changes/[^/]+/revisions", hookChange],
    ["POST", "/v1/hook-changes/[^/]+/reviews", hookChange],
    ["POST", "/v1/hook-changes/[^/]+/reject", hookChange],
    ["POST", "/v1/hook-changes/[^/]+/merge", hookChange],
    ["POST", "/v1/hook-changes/[^/]+/discussions", hookChange],
    ["POST", "/v1/hook-changes/[^/]+/discussions/[^/]+/comments", hookChange],
    ["POST", "/v1/hook-changes/[^/]+/discussions/[^/]+/resolve", hookChange],
    ["POST", "/v1/hook-changes/[^/]+/discussions/[^/]+/apply", hookChange],

    ["GET", "/v1/knowledge", page(contract.knowledgeIndexSchema)],
    ["POST", "/v1/knowledge/publish", sample(contract.knowledgeDocumentSchema)],
    ["GET", "/v1/knowledge/[^/]+", sample(contract.knowledgeDocumentSchema)],

    ["GET", "/v1/developers", page(contract.developerListSchema)],
    [
      "GET",
      "/v1/developers/[^/]+/assets",
      page(contract.developerAssetsSchema),
    ],

    ["GET", "/v1/github/status", sample(contract.githubStatusSchema)],
    [
      "GET",
      "/v1/github/installations",
      [sample(contract.gitInstallationSchema)],
    ],
    [
      "POST",
      "/v1/github/(authorize|install)",
      sample(contract.gitAuthorizationSchema),
    ],
    ["GET", "/v1/git-connections", [sample(contract.gitConnectionSchema)]],
    [
      "POST",
      "/v1/git-connections/import-copy",
      sample(contract.gitCopyImportResultSchema),
    ],
    [
      "GET",
      "/v1/git-connections/[^/]+/remote-head",
      sample(contract.gitRemoteHeadSchema),
    ],
    [
      "POST",
      "/v1/git-connections/[^/]+/mirror-resolution",
      sample(contract.okSchema),
    ],
    [
      "GET",
      "/v1/git-connections/[^/]+/pulls",
      [sample(contract.gitPullSchema)],
    ],
    ["POST", "/v1/git-connections/[^/]+/pulls", sample(contract.gitPullSchema)],
    [
      "PUT",
      "/v1/git-connections/[^/]+/pulls/\\d+/revisions",
      sample(contract.gitPullSchema),
    ],
    [
      "PUT",
      "/v1/git-connections/[^/]+/pulls/\\d+/merge",
      sample(contract.gitConnectionSchema),
    ],
    [
      "GET",
      "/v1/git-connections/[^/]+/pulls/\\d+/package",
      () => download("skill"),
    ],
    [
      "GET",
      "/v1/git-connections/[^/]+/pulls/\\d+",
      sample(contract.gitPullDetailsSchema),
    ],
    [
      "POST",
      "/v1/git-connections/[^/]+/pulls/\\d+/reviews",
      sample(contract.gitPullDetailsSchema),
    ],
    [
      "POST",
      "/v1/git-connections/[^/]+/pulls/\\d+/comments",
      sample(contract.gitPullDetailsSchema),
    ],
    ["GET", "/v1/git-connections/[^/]+", sample(contract.gitConnectionSchema)],
    ["POST", "/v1/git-connections", sample(contract.gitConnectionSchema)],
    [
      "POST",
      "/v1/git-connections/import",
      sample(contract.gitConnectionSchema),
    ],
    [
      "POST",
      "/v1/git-connections/create-repository",
      sample(contract.gitConnectionSchema),
    ],
    [
      "POST",
      "/v1/git-connections/[^/]+/sync",
      sample(contract.gitConnectionSchema),
    ],
  ];

  return routes.map(([method, path, reply]) => ({
    method,
    path: new RegExp(`^${path}$`),
    reply,
  }));
}

/** A package download as the server sends it: the archive, with its commit as the ETag. */
export async function packageReply(
  files: { path: string; content: string; executable: boolean }[],
  commit: string,
  home: string,
) {
  return new Response(await archive(files, testRuntime(home)), {
    headers: { etag: `"${commit}"` },
  });
}

export type Cloud = {
  home: string;
  /** Every request so far, as `METHOD /path?query`. */
  requests: string[];
  /** The JSON bodies sent so far, in order; for an upload, its metadata. */
  bodies: unknown[];
  /** Requests paired with their JSON body or upload metadata. */
  sent: { request: string; body: unknown }[];
  /** Replaces what a route answers; `path` is a regular expression source. */
  respond(method: string, path: string, reply: Reply): void;
  /** Runs one command line and returns what it printed. */
  run(args: string[], options?: ProgramOptions): Promise<string>;
};

/**
 * A temporary home signed in to the fake server, with `fetch` routed to it
 * until the test ends.
 */
export async function cloud(
  t: TestContext,
  settings: Partial<Settings> = {},
): Promise<Cloud> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "barndog-cloud-")));
  const { organization, developer } = sample(contract.contextSchema);

  await saveSettings(
    {
      harnesses: [],
      connection: { server: SERVER, organizationId: ID, developerId: ID },
      ...settings,
    },
    home,
  );

  await updateCredentials(testRuntime(home), (credentials) => {
    credentials.selectedServer = SERVER;
    credentials.servers[SERVER] = {
      token: "t".repeat(43),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      context: { organization, developer },
    };
  });

  const routes = defaultRoutes(home);
  const requests: string[] = [];
  const bodies: unknown[] = [];
  const sent: Cloud["sent"] = [];
  const unexpected: string[] = [];

  vi.stubGlobal("fetch", async (request: Request) => {
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    let body: unknown;
    const type = request.headers.get("content-type") ?? "";
    if (type.includes("application/json")) {
      body = await request.clone().json();
      bodies.push(body);
    } else if (type.includes("multipart/form-data")) {
      const metadata = (await request.clone().formData()).get("metadata");
      body = typeof metadata === "string" ? JSON.parse(metadata) : null;
      bodies.push(body);
    }

    sent.push({
      request: `${request.method} ${url.pathname}${url.search}`,
      body,
    });

    for (const route of routes) {
      const match = url.pathname.match(route.path);
      if (!match || route.method !== request.method) {
        continue;
      }

      const reply =
        typeof route.reply === "function"
          ? await (route.reply as (r: Request, m: RegExpMatchArray) => unknown)(
              request,
              match,
            )
          : route.reply;

      return reply instanceof Response ? reply : Response.json(reply);
    }

    const message = `Unexpected Cloud request: ${request.method} ${url.href}`;
    unexpected.push(message);
    throw new Error(message);
  });

  t.onTestFinished(async () => {
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
    expect(
      unexpected,
      "Every Cloud request must have an explicit route",
    ).toEqual([]);
  });

  return {
    home,
    requests,
    bodies,
    sent,
    respond(method, path, reply) {
      routes.unshift({ method, path: new RegExp(`^${path}$`), reply });
    },
    async run(args, options = {}) {
      const output: string[] = [];
      try {
        await createProgram({
          home,
          interactive: false,
          write: (text) => output.push(text),
          writeError: (text) => output.push(text),
          ...options,
        }).parseAsync(args, { from: "user" });
      } catch (error) {
        if (!unexpected.length) {
          throw error;
        }
      }

      const failures = unexpected.splice(0);
      if (failures.length) {
        throw new Error(failures.join("\n"));
      }

      return output.join("\n");
    },
  };
}
