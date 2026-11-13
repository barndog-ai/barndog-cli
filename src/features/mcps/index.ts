import { homedir } from "node:os";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import {
  mcpDefinitionSchema,
  mcpSchema,
  mcpVersionSchema,
} from "@barndog-ai/api-contract";
import { connection, selectOrigin } from "../collaboration/remote.js";
import { request, selectAsset, type RetryKey } from "../environment/remote.js";
import { readSettings } from "../../config/settings.js";
import {
  repoForOrigin,
  selectRepoAsset,
  showRepoAsset,
} from "../git-workspace/assets.js";
import { gitVersions } from "../collaboration/workspace-git.js";
import type { Harness } from "../../harnesses/types.js";
import {
  patchNative,
  nativeFile,
  type NativeEntry,
} from "../native/configuration.js";
import { fileText } from "../environment/transaction.js";
import { defined } from "../../shared/lookup.js";

export type McpWriteInput = {
  name: string;
  origin: string;
  /** Path of the JSON connection definition. */
  file: string;
  key?: RetryKey;
};

async function readDefinition(file: string) {
  return mcpDefinitionSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

/** Publishes a new MCP configuration in a scope. */
export async function createMcp(input: McpWriteInput, home = homedir()) {
  const conn = await connection(home),
    scope = await selectOrigin(input.origin, conn, home);
  const definition = await readDefinition(input.file);
  return request(conn, "/v1/mcps", mcpSchema, home, "POST", {
    name: input.name,
    origin: { type: scope.type, id: scope.id },
    definition,
    idempotencyKey: input.key ?? randomUUID(),
  });
}

/** Publishes a new revision of an MCP configuration, against the inspected version. */
export async function updateMcp(
  input: McpWriteInput & { expectedVersion: string },
  home = homedir(),
) {
  const conn = await connection(home);
  await selectOrigin(input.origin, conn, home);
  const definition = await readDefinition(input.file);
  const selected = await selectAsset("mcp", input.name, input.origin, home);
  return request(
    conn,
    `/v1/mcps/${selected.reference.id}/versions`,
    mcpSchema,
    home,
    "POST",
    {
      definition,
      expectedVersionId: z.uuidv4().parse(input.expectedVersion),
      idempotencyKey: input.key ?? randomUUID(),
    },
  );
}

/** One MCP configuration with its definition, from the repo or the server. */
export async function showMcp(name: string, origin: string, home = homedir()) {
  const settings = await readSettings(home);
  const repo = settings && repoForOrigin(settings, home, origin);
  if (repo)
    return showRepoAsset(
      selectRepoAsset(await repo.model(), "mcp", name, origin),
    );
  return (await selectAsset("mcp", name, origin, home)).asset;
}

export async function mcpVersions(
  name: string,
  origin: string,
  home = homedir(),
) {
  const settings = await readSettings(home);
  if (settings?.gitWorkspace)
    return gitVersions(
      settings.gitWorkspace,
      { name, origin, kind: "mcp" },
      home,
    );
  const selected = await selectAsset("mcp", name, origin, home);
  return request(
    selected.connection,
    `/v1/mcps/${selected.reference.id}/versions`,
    z.array(mcpVersionSchema),
    home,
  );
}

/** The native entries in state.json, as far as authentication reads them. */
const installedMcpSchema = z.looseObject({
  native: z
    .array(
      z.looseObject({
        id: z.string(),
        kind: z.string(),
        harness: z.string(),
        file: z.string(),
        key: z.string(),
        value: z.record(z.string(), z.unknown()),
      }),
    )
    .default([]),
});

export async function authenticateMcp(
  name: string,
  origin: string,
  harness: Harness,
  home = homedir(),
) {
  const settings = await readSettings(home);
  const repo = settings && repoForOrigin(settings, home, origin);
  const asset = repo
    ? await (async () => {
        const found = selectRepoAsset(await repo.model(), "mcp", name, origin);
        return {
          id: found.id,
          name: found.name,
          definition: defined(
            found.definition,
            `${found.name} has no MCP definition`,
          ),
        };
      })()
    : await (async () => {
        const selected = await selectAsset("mcp", name, origin, home),
          parsed = mcpSchema.parse(selected.asset);
        return {
          id: parsed.id,
          name: parsed.name,
          definition: parsed.version.definition,
        };
      })();
  const definition = asset.definition;
  if (definition.authentication !== "native-oauth") {
    const refs =
      definition.transport === "stdio"
        ? definition.environment
        : definition.headers;
    return {
      message:
        definition.authentication === "none"
          ? "No authentication is required."
          : `Supply local environment variables: ${Object.values(refs)
              .map((v) => v.secretRef)
              .join(", ")}. Credential values are never uploaded.`,
    };
  }
  const { native } = installedMcpSchema.parse(
    JSON.parse((await fileText(join(home, ".barndog/state.json"))) ?? "{}"),
  );
  const installed = native.find(
    (e) => e.id === asset.id && e.kind === "mcp" && e.harness === harness,
  );
  if (!installed)
    throw new Error(
      "Install and enable this MCP for the selected harness before authenticating",
    );
  const entry: NativeEntry = { ...installed, kind: "mcp", harness };
  if (entry.file !== nativeFile(harness, "mcp", home))
    throw new Error("Invalid native installation state");
  patchNative(await fileText(entry.file), [entry], [entry]);
  if (harness === "cursor")
    return {
      message: `Open Cursor → Settings → MCP and authenticate ${asset.name}. Cursor manages this login locally.`,
    };
  const cwd = join(home, ".barndog/native-auth");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const command = harness === "claude" ? "claude" : "codex";
  const child = spawn(command, ["mcp", "login", asset.name], {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (code)
    throw new Error(
      `Native ${harness} authentication did not complete (${code})`,
    );
  return {
    message: `${harness} authentication completed. Credentials remain in native storage.`,
  };
}
