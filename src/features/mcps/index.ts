import { localPath } from "../../platform.js";
import type { RuntimeContext } from "../../runtime.js";
import { POSIX_MODE } from "../../shared/constants.js";
import { readState } from "../../config/state.js";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import crossSpawn from "cross-spawn";
import { z } from "zod";
import {
  type McpDefinition,
  mcpDefinitionSchema,
  mcpSchema,
  mcpVersionSchema,
} from "@barndog-ai/api-contract";
import { selectOrigin } from "../server/origin.js";
import { connection } from "../server/connection.js";
import { selectAsset } from "../server/catalog.js";
import { type RetryKey, parsed } from "../server/client.js";
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
import { missingValues } from "../secrets/index.js";
import { keptValues } from "../environment/kept-values.js";
import type { Harness } from "../../harnesses/types.js";
import { patchNative, type NativeEntry } from "../native/configuration.js";
import { fileText, inputJson } from "../../shared/files.js";
import {
  type ConfirmUrlQuery,
  mayShareUrlQueries,
} from "../asset-kinds/url-query.js";
import { defined } from "../../shared/lookup.js";
import { CliError, friendlyMessage } from "../../errors.js";
import { barndogPaths } from "../../config/paths.js";
import { apiClient } from "../auth/transport.js";

export type McpWriteInput = {
  name: string;
  origin: string;
  /** Path of the JSON connection definition. */
  file: string;
  key?: RetryKey;
  /**
   * Asked before publishing a definition whose URL has a query string; without
   * it such a definition isn't published.
   */
  confirmUrlQuery?: ConfirmUrlQuery;
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

/** The definition in `input.file`, once the developer agrees to share any URL query it has. */
async function readDefinition(input: McpWriteInput, runtime: RuntimeContext) {
  const { file } = input;
  const result = mcpDefinitionSchema.safeParse(
    await inputJson(localPath(file, runtime)),
  );

  if (!result.success) {
    throw new CliError(
      `${file} isn't an MCP definition: ${friendlyMessage(result.error)}.`,
      "Check the fields against the MCP definition format at barndog.dev/docs",
      { cause: result.error },
    );
  }

  if (
    !(await mayShareUrlQueries(
      [{ name: input.name, definition: result.data }],
      input.confirmUrlQuery,
    ))
  ) {
    throw new CliError("Nothing was published.");
  }

  return result.data;
}

/** Publishes a new MCP configuration in a scope. */
export async function createMcp(
  input: McpWriteInput,
  runtime: RuntimeContext,
): Promise<McpServer> {
  const conn = await connection(runtime);
  const scope = await selectOrigin(input.origin, conn, runtime);

  const definition = await readDefinition(input, runtime);

  return parsed(
    mcpSchema,
    apiClient(conn.server, runtime).POST("/v1/mcps", {
      body: {
        name: input.name,
        origin: { type: scope.type, id: scope.id },
        definition,
        idempotencyKey: input.key ?? randomUUID(),
      },
    }),
  );
}

/** Publishes a new revision of an MCP configuration, against the inspected version. */
export async function updateMcp(
  input: McpUpdateInput,
  runtime: RuntimeContext,
): Promise<McpServer> {
  const conn = await connection(runtime);
  await selectOrigin(input.origin, conn, runtime);
  const definition = await readDefinition(input, runtime);
  const selected = await selectAsset("mcp", input.name, input.origin, runtime);

  return parsed(
    mcpSchema,
    apiClient(conn.server, runtime).POST("/v1/mcps/{id}/versions", {
      params: { path: { id: selected.reference.id } },
      body: {
        definition,
        expectedVersionId: z.uuidv4().parse(input.expectedVersion),
        idempotencyKey: input.key ?? randomUUID(),
      },
    }),
  );
}

/**
 * An MCP configuration as `mcp show` prints it, with the variables it refers to
 * that have no value on this machine.
 */
export type ShownMcp = (RepoAssetView | PublishedAsset) & {
  unsetVariables: string[];
};

/** One MCP configuration with its definition, from the repo or the server. */
export async function showMcp(
  name: string,
  origin: string,
  runtime: RuntimeContext,
): Promise<ShownMcp> {
  const { home } = runtime;

  const settings = await readSettings(home);
  const repo = settings && repoForOrigin(settings, runtime, origin);
  const withUnset = async (
    asset: RepoAssetView | PublishedAsset,
    definition: McpDefinition | undefined,
  ): Promise<ShownMcp> => ({
    ...asset,
    unsetVariables: definition
      ? missingValues(
          definition,
          (await keptValues(runtime)).servers[asset.id] ?? {},
          runtime.env,
        ).map((missing) => missing.variable)
      : [],
  });

  if (repo) {
    const view = showRepoAsset(
      selectRepoAsset(await repo.model(), "mcp", name, origin),
    );

    return withUnset(view, view.definition);
  }

  const { asset } = await selectAsset("mcp", name, origin, runtime);

  return withUnset(asset, mcpSchema.parse(asset).version.definition);
}

export async function mcpVersions(
  name: string,
  origin: string,
  runtime: RuntimeContext,
): Promise<PackageVersion[] | McpVersion[]> {
  const { home } = runtime;

  const settings = await readSettings(home);
  if (settings?.gitWorkspace) {
    return gitVersions(
      settings.gitWorkspace,
      { name, origin, kind: "mcp" },
      runtime,
    );
  }

  const selected = await selectAsset("mcp", name, origin, runtime);

  return parsed(
    z.array(mcpVersionSchema),
    apiClient(selected.connection.server, runtime).GET(
      "/v1/mcps/{id}/versions",
      {
        params: { path: { id: selected.reference.id } },
      },
    ),
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
  runtime: RuntimeContext,
): Promise<McpAuthentication> {
  const { home } = runtime;

  const settings = await readSettings(home);
  const repo = settings && repoForOrigin(settings, runtime, origin);
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
        const selected = await selectAsset("mcp", name, origin, runtime);
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
      message: `Open ${tool} → ${mcp.login.settings} and authenticate ${installed.key}. ${tool} manages this login locally.`,
    };
  }

  const [command, ...loginArguments] = mcp.login.command;
  const login = mcp.login.command.join(" ");
  if (!command) {
    throw new Error(`The ${tool} adapter has an empty MCP login command`);
  }

  const cwd = barndogPaths(home).nativeAuth;
  await mkdir(cwd, { recursive: true, mode: POSIX_MODE.privateDirectory });
  // cross-spawn also starts Windows .cmd shims, such as an npm-installed claude.
  // The installed key differs from the asset's name after a clash rename.
  const child = crossSpawn(command, [...loginArguments, installed.key], {
    cwd,
    stdio: "inherit",
    env: { ...runtime.env },
  });

  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });

  if (code) {
    throw new CliError(
      `${login} exited with code ${code}, so sign-in didn't finish.`,
      `${login} ${installed.key}`,
    );
  }

  return {
    message: `${harness} authentication completed. Credentials remain in native storage.`,
  };
}
