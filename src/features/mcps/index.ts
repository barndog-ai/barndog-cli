import { POSIX_MODE } from "../../shared/constants.js";
import { readState } from "../../config/state.js";
import { homedir } from "node:os";
import { readFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import {
  mcpDefinitionSchema,
  mcpSchema,
  mcpVersionSchema,
} from "@barndog-ai/api-contract";
import { selectOrigin } from "../server/origin.js";
import { connection } from "../server/connection.js";
import { selectAsset } from "../server/catalog.js";
import { type RetryKey, request } from "../server/request.js";
import { readSettings } from "../../config/settings.js";
import type { McpServer, PublishedAsset } from "../asset-kinds/index.js";
import {
  repoForOrigin,
  selectRepoAsset,
  showRepoAsset,
  type RepoAssetView,
} from "../workspace/assets.js";
import { gitVersions } from "../collaboration/workspace-git.js";
import type { PackageVersion } from "../collaboration/results.js";
import { adapters } from "../../harnesses/registry.js";
import type { Harness } from "../../harnesses/types.js";
import { patchNative, type NativeEntry } from "../native/configuration.js";
import { fileText } from "../../shared/files.js";
import { defined } from "../../shared/lookup.js";
import { CliError } from "../../errors.js";
import { barndogPaths } from "../../config/paths.js";

export type McpWriteInput = {
  name: string;
  origin: string;
  /** Path of the JSON connection definition. */
  file: string;
  key?: RetryKey;
};

/** One published revision of an MCP configuration. */
export type McpVersion = z.infer<typeof mcpVersionSchema>;

/** What to do, or what was done, to sign in to an MCP server. */
export type McpAuthentication = { message: string };

/**
 * MCP replacement input requiring the inspected version ID to guard against
 * concurrent changes.
 */
export type McpUpdateInput = McpWriteInput & {
  /** The version ID that was inspected; the update is refused if another landed since. */
  expectedVersion: string;
};

async function readDefinition(file: string) {
  return mcpDefinitionSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

/** Publishes a new MCP configuration in a scope. */
export async function createMcp(
  input: McpWriteInput,
  home = homedir(),
): Promise<McpServer> {
  const conn = await connection(home);
  const scope = await selectOrigin(input.origin, conn, home);

  const definition = await readDefinition(input.file);

  return request(conn, "/v1/mcps", mcpSchema, {
    home,
    method: "POST",
    body: {
      name: input.name,
      origin: { type: scope.type, id: scope.id },
      definition,
      idempotencyKey: input.key ?? randomUUID(),
    },
  });
}

/** Publishes a new revision of an MCP configuration, against the inspected version. */
export async function updateMcp(
  input: McpUpdateInput,
  home = homedir(),
): Promise<McpServer> {
  const conn = await connection(home);
  await selectOrigin(input.origin, conn, home);
  const definition = await readDefinition(input.file);
  const selected = await selectAsset("mcp", input.name, input.origin, home);

  return request(
    conn,
    `/v1/mcps/${selected.reference.id}/versions`,
    mcpSchema,
    {
      home,
      method: "POST",
      body: {
        definition,
        expectedVersionId: z.uuidv4().parse(input.expectedVersion),
        idempotencyKey: input.key ?? randomUUID(),
      },
    },
  );
}

/** One MCP configuration with its definition, from the repo or the server. */
export async function showMcp(
  name: string,
  origin: string,
  home = homedir(),
): Promise<RepoAssetView | PublishedAsset> {
  const settings = await readSettings(home);
  const repo = settings && repoForOrigin(settings, home, origin);
  if (repo) {
    return showRepoAsset(
      selectRepoAsset(await repo.model(), "mcp", name, origin),
    );
  }

  return (await selectAsset("mcp", name, origin, home)).asset;
}

export async function mcpVersions(
  name: string,
  origin: string,
  home = homedir(),
): Promise<PackageVersion[] | McpVersion[]> {
  const settings = await readSettings(home);
  if (settings?.gitWorkspace) {
    return gitVersions(
      settings.gitWorkspace,
      { name, origin, kind: "mcp" },
      home,
    );
  }

  const selected = await selectAsset("mcp", name, origin, home);

  return request(
    selected.connection,
    `/v1/mcps/${selected.reference.id}/versions`,
    z.array(mcpVersionSchema),
    { home },
  );
}

/**
 * Guides MCP authentication or starts the native harness login command;
 * credentials remain in native storage.
 */
export async function authenticateMcp(
  name: string,
  origin: string,
  harness: Harness,
  home = homedir(),
): Promise<McpAuthentication> {
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
        const selected = await selectAsset("mcp", name, origin, home);
        const parsed = mcpSchema.parse(selected.asset);

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

  const { native } = await readState(home);

  const installed = native.find(
    (e) => e.id === asset.id && e.kind === "mcp" && e.harness === harness,
  );

  if (!installed) {
    throw new CliError(
      `${asset.name} isn't installed and enabled for ${harness}.`,
      `barndog mcp install ${asset.name}`,
    );
  }

  const entry: NativeEntry = { ...installed, kind: "mcp", harness };
  patchNative(await fileText(entry.file), [entry], [entry]);
  const { name: tool, mcp } = adapters[harness];
  if ("settings" in mcp.login) {
    return {
      message: `Open ${tool} → ${mcp.login.settings} and authenticate ${asset.name}. ${tool} manages this login locally.`,
    };
  }

  const [command, ...loginArguments] = mcp.login.command;
  const login = mcp.login.command.join(" ");
  if (!command) {
    throw new Error(`The ${tool} adapter has an empty MCP login command`);
  }

  const cwd = barndogPaths(home).nativeAuth;
  await mkdir(cwd, { recursive: true, mode: POSIX_MODE.privateDirectory });
  const child = spawn(command, [...loginArguments, asset.name], {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });

  if (code) {
    throw new CliError(
      `${login} exited with code ${code}, so sign-in didn't finish.`,
      `${login} ${asset.name}`,
    );
  }

  return {
    message: `${harness} authentication completed. Credentials remain in native storage.`,
  };
}
