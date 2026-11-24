import { stripVTControlCharacters } from "node:util";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, expect, test, vi, type TestContext } from "vitest";
import type { McpDefinition } from "@barndog-ai/api-contract";

import { CliError } from "../errors.js";
import { readSettings } from "../config/settings.js";
import {
  mayShareUrlQueries,
  queryParameters,
  urlQueries,
} from "../features/asset-kinds/url-query.js";
import { convertServer } from "../features/mcps/import.js";
import { moveLocalAssets } from "../features/migration/move.js";
import { type AddContext } from "../ui/add-asset.js";
import { addMcp } from "../ui/add-mcp.js";
import { confirmSharingUrlQuery } from "../ui/mcp.js";
import { runSetup } from "../ui/onboarding.js";
import { cloud } from "./cloud.js";
import { testRuntime } from "./runtime.js";

/** Supabase's hosted server, configured through its query string. */
const SUPABASE =
  "https://mcp.supabase.com/mcp?project_ref=abc&read_only=true&features=docs%2Cdatabase";

const http = (url: string): McpDefinition => ({
  transport: "http",
  url,
  headers: {},
  description: "Supabase",
  authentication: "none",
});

async function localHome(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "barndog-cli-")));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await runSetup({
    runtime: testRuntime(home),
    local: true,
    restart: true,
    interactive: true,
    detected: [],
    write: () => {},
    confirmRestart: async () => true,
    confirmApply: async () => true,
    choose: async () => ["claude"],
  });

  const settings = await readSettings(home);
  assert(settings?.localWorkspace);

  return { home, folder: settings.localWorkspace.path };
}

test("a URL's query parameters are named once each, never with their values", () => {
  expect(queryParameters(http(SUPABASE))).toStrictEqual([
    "project_ref",
    "read_only",
    "features",
  ]);

  expect(queryParameters(http("https://a.test/mcp?x=1&x=2"))).toStrictEqual([
    "x",
  ]);

  expect(queryParameters(http("https://a.test/mcp"))).toStrictEqual([]);
  expect(queryParameters(http("https://a.test/mcp?"))).toStrictEqual([]);
  expect(
    queryParameters({
      transport: "stdio",
      command: "node",
      args: ["--url=https://a.test/mcp?token=1"],
      environment: {},
      description: "Local",
      authentication: "none",
    }),
  ).toStrictEqual([]);

  expect(
    urlQueries([
      { name: "supabase", definition: http(SUPABASE) },
      { name: "plain", definition: http("https://a.test/mcp") },
      { name: "notes" },
    ]),
  ).toStrictEqual([
    { name: "supabase", parameters: ["project_ref", "read_only", "features"] },
  ]);
});

test("a server with a URL query is shared only when someone agrees", async () => {
  const servers = [{ name: "supabase", definition: http(SUPABASE) }];
  const plain = [{ name: "plain", definition: http("https://a.test/mcp") }];

  expect(await mayShareUrlQueries(plain, undefined)).toBe(true);
  expect(await mayShareUrlQueries(servers, undefined)).toBe(false);
  expect(await mayShareUrlQueries(servers, async () => false)).toBe(false);
  expect(await mayShareUrlQueries(servers, async () => true)).toBe(true);
});

test("sharing a URL query asks in a terminal and needs --allow-url-query elsewhere", async () => {
  const queries = [{ name: "supabase", parameters: ["project_ref"] }];
  const lines: string[] = [];
  const ask = vi.fn().mockResolvedValue(false);
  const options = {
    write: (line: string) => lines.push(line),
    fix: "barndog local move supabase --keep-local --allow-url-query",
    ask,
  };

  expect(
    await confirmSharingUrlQuery({ ...options, interactive: true })(queries),
  ).toBe(false);

  expect(ask).toHaveBeenCalledWith("Share it anyway?");
  const text = stripVTControlCharacters(lines.join("\n"));
  expect(text).toMatch(/supabase's URL has query parameters: project_ref\./);
  expect(text).toMatch(/everyone who can see the destination/);

  await expect(
    confirmSharingUrlQuery({ ...options, interactive: false })(queries),
  ).rejects.toSatisfy(
    (error: CliError) =>
      error instanceof CliError &&
      /supabase has a URL with query parameters/.test(error.message) &&
      error.hint === options.fix,
  );

  ask.mockClear();
  expect(
    await confirmSharingUrlQuery({
      ...options,
      interactive: false,
      allowed: true,
    })(queries),
  ).toBe(true);

  expect(ask).not.toHaveBeenCalled();
});

test("an imported server's URL query is kept as written, with a note to check it", () => {
  const converted = convertServer({
    name: "supabase",
    server: { url: SUPABASE },
  });

  assert(converted.definition.transport === "http");
  expect(converted.definition.url).toBe(SUPABASE);
  expect(converted.notes.join("\n")).toMatch(
    /query parameters project_ref, read_only, features as written/,
  );

  expect(
    convertServer({ name: "docs", server: { url: "https://docs.test/mcp" } })
      .notes,
  ).toStrictEqual([]);
});

test("mcp add warns about a URL query and adds the server only if the developer agrees", async (t) => {
  const { home, folder } = await localHome(t);
  const lines: string[] = [];
  const yes = vi.fn().mockResolvedValue(false);
  const context: AddContext = {
    runtime: testRuntime(home),
    interactive: true,
    write: (line) => lines.push(line),
    prompts: { yes } as unknown as AddContext["prompts"],
  };

  const config = JSON.stringify({ url: SUPABASE, headers: {} });
  await expect(addMcp("supabase", { config }, context)).rejects.toThrow(
    "Nothing was added.",
  );

  expect(yes).toHaveBeenCalledWith("Add it?");
  expect(stripVTControlCharacters(lines.join("\n"))).toMatch(
    /stays on this machine and works as is/,
  );

  await expect(
    readFile(join(folder, "org/mcp/supabase.yaml"), "utf8"),
  ).rejects.toThrow();

  yes.mockResolvedValue(true);
  await addMcp("supabase", { config }, context);
  expect(
    await readFile(join(folder, "org/mcp/supabase.yaml"), "utf8"),
  ).toContain(SUPABASE);
});

test("without a terminal, mcp add adds a URL query to the local folder and says what to check", async (t) => {
  const { home, folder } = await localHome(t);
  const lines: string[] = [];

  await addMcp(
    "supabase",
    { config: JSON.stringify({ url: SUPABASE, headers: {} }) },
    {
      runtime: testRuntime(home),
      interactive: false,
      write: (line) => lines.push(line),
      prompts: {} as AddContext["prompts"],
    },
  );

  expect(
    await readFile(join(folder, "org/mcp/supabase.yaml"), "utf8"),
  ).toContain(SUPABASE);

  expect(stripVTControlCharacters(lines.join("\n"))).toMatch(
    /supabase: Its URL keeps the query parameters/,
  );
});

test("moving a local server with a URL query stops unless the developer agrees", async (t) => {
  const { home } = await localHome(t);
  await addMcp(
    "supabase",
    { config: JSON.stringify({ url: SUPABASE, headers: {} }) },
    {
      runtime: testRuntime(home),
      interactive: false,
      write: () => {},
      prompts: {} as AddContext["prompts"],
    },
  );

  const confirmUrlQuery = vi.fn().mockResolvedValue(false);
  // The check comes before the destination is reached, so this one never is.
  const options = { keepLocal: true, repo: "https://git.invalid/team.git" };

  await expect(
    moveLocalAssets({ ...options, confirmUrlQuery }, testRuntime(home)),
  ).rejects.toThrow("Nothing was moved.");

  expect(confirmUrlQuery).toHaveBeenCalledWith([
    { name: "supabase", parameters: ["project_ref", "read_only", "features"] },
  ]);

  await expect(
    moveLocalAssets(options, testRuntime(home)),
    "nobody was asked",
  ).rejects.toThrow("Nothing was moved.");
});

test("mcp create publishes a URL query only with --allow-url-query outside a terminal", async (t) => {
  const server = await cloud(t);
  const file = join(server.home, "server.json");
  await writeFile(file, JSON.stringify(http(SUPABASE)));
  const create = ["mcp", "create", "supabase", "--origin", "org"];

  await expect(server.run([...create, "--file", file])).rejects.toSatisfy(
    (error: CliError) =>
      error instanceof CliError &&
      error.hint ===
        `barndog mcp create supabase --origin org --file ${file} --allow-url-query`,
  );

  expect(server.requests).not.toContain("POST /v1/mcps");

  await server.run([...create, "--file", file, "--allow-url-query"]);
  expect(server.requests).toContain("POST /v1/mcps");
  expect(server.bodies).toMatchObject([{ definition: { url: SUPABASE } }]);
});
