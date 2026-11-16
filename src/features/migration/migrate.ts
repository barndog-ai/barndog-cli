import type { RuntimeContext } from "../../runtime.js";
import {
  mcpSchema,
  knowledgeDocumentSchema,
  knowledgeIndexSchema,
} from "@barndog-ai/api-contract";

import { selectionState, withSelection } from "../../config/environment.js";
import {
  readSettings,
  saveSettings,
  SetupRequiredError,
  type Connection,
} from "../../config/settings.js";
import { CliError } from "../../errors.js";
import type { AssetReference } from "../asset-selection/types.js";
import type { SelectionState, PackageKind } from "../../config/selection.js";
import { normalizeServer, apiClient } from "../auth/transport.js";
import { packageApi } from "../collaboration/api.js";
import { archive } from "../collaboration/workspace.js";
import {
  encodeFiles,
  type PackageUpload,
} from "../collaboration/workspace-store.js";
import { originLabel, scopes } from "../server/origin.js";
import { environmentCatalog } from "../server/catalog.js";
import type { ApiScope } from "../server/origin.js";
import { parsed } from "../server/client.js";
import { synchronize } from "../environment/sync.js";
import { locked } from "../environment/transaction.js";
import { openRepoSource } from "../workspace/workspace-source.js";
import { connectionContext } from "../auth/session.js";
import type {
  RepoAsset,
  RepoKnowledge,
  RepoScope,
  WorkspaceModel,
} from "../workspace/format.js";
import { localOverlay } from "../workspace/overlay.js";
import { PAGE_SIZE } from "../server/pages.js";
import { defined } from "../../shared/lookup.js";

/**
 * What `migrate` does with one asset or knowledge document: publish it, leave
 * it (`exists` in Cloud already), or stop because it is invalid or its scope
 * doesn't exist in Cloud yet.
 */
export type MigrationRow = {
  kind: string;
  name: string;
  origin: string;
  action: "publish" | "exists" | "invalid" | "missing-scope";
  detail?: string;
};

export type PublishableAsset = Pick<
  RepoAsset,
  "id" | "kind" | "name" | "publishedVersion" | "entries" | "definition"
>;

const sameScope = (cloud: ApiScope, local: RepoScope) =>
  cloud.type === local.type &&
  (local.type === "org" || cloud.slug === local.slug);

/**
 * Publishes a Skill or Hook to a Cloud scope by proposing it and merging the
 * proposal at once. The retry key comes from the asset and version, so re-
 * running after a failure repeats the upload instead of duplicating it.
 */
export async function publishPackage(
  asset: PublishableAsset & { kind: PackageKind },
  scope: ApiScope,
  conn: Connection,
  runtime: RuntimeContext,
) {
  const api = packageApi(asset.kind, conn, runtime);
  const files = encodeFiles(asset.entries);
  const metadata: PackageUpload = {
    name: asset.name,
    origin: { type: scope.type, id: scope.id },
    baseVersionId: null,
    title: `Migrate ${asset.name} from Git`,
    // Stable per content, so re-running after a failure repeats rather than duplicates.
    idempotencyKey: `migrate-${asset.id}-${asset.publishedVersion}-${scope.id}-${asset.name}`,
  };

  const change = await api.submit(metadata, await archive(files, runtime));

  await api.merge(change.id, { expectedRevision: change.submittedRevision });
}

/**
 * Publishes an MCP configuration to a Cloud scope, with a retry key from the
 * asset and version.
 */
export const publishMcp = (
  asset: PublishableAsset,
  scope: ApiScope,
  conn: Connection,
  runtime: RuntimeContext,
) => {
  return parsed(
    mcpSchema,
    apiClient(conn.server, runtime).POST("/v1/mcps", {
      body: {
        name: asset.name,
        origin: { type: scope.type, id: scope.id },
        definition: defined(
          asset.definition,
          `The MCP configuration ${asset.name} has no definition`,
        ),
        idempotencyKey: `migrate-${asset.id}-${asset.publishedVersion}-${scope.id}-${asset.name}`,
      },
    }),
  );
};

export const publishKnowledge = (
  doc: Pick<RepoKnowledge, "id" | "version" | "content">,
  conn: Connection,
  runtime: RuntimeContext,
) => {
  return parsed(
    knowledgeDocumentSchema,
    apiClient(conn.server, runtime).POST("/v1/knowledge/publish", {
      body: {
        baseVersionId: null,
        content: doc.content,
        idempotencyKey: `migrate-${doc.id}-${doc.version}-${doc.content.name}`,
      },
    }),
  );
};

/** Carries each choice over by scope and name, because cloud assigns new IDs. */
function translateSelection(
  state: SelectionState,
  scopes: { local: RepoScope; cloud: ApiScope }[],
  assets: readonly RepoAsset[],
  target: readonly AssetReference[],
): SelectionState {
  const assetId = (id: string) => {
    const asset = assets.find((a) => a.id === id);
    const pair = asset && scopes.find((s) => s.local.id === asset.origin.id);

    return target.find(
      (t) =>
        t.kind === asset?.kind &&
        t.name === asset.name &&
        t.origin.type === pair?.cloud.type &&
        t.origin.id === pair.cloud.id,
    )?.id;
  };

  const ids = (values: readonly string[]) =>
    values.flatMap((id) => assetId(id) ?? []);

  return {
    subscriptions: state.subscriptions.flatMap((subscription) => {
      const pair = scopes.find((s) => s.local.id === subscription.scope.id);

      return pair && pair.cloud.type !== "dev"
        ? [
            {
              ...subscription,
              scope: { type: pair.cloud.type, id: pair.cloud.id },
            },
          ]
        : [];
    }),
    individualAssetIds: ids(state.individualAssetIds),
    excludedAssetIds: ids(state.excludedAssetIds),
    disabledAssetIds: ids(state.disabledAssetIds),
  };
}

/** A kept local folder isn't part of the move, so its choices stay as they were. */
function keepLocalChoices(
  next: SelectionState,
  before: SelectionState,
  kept: WorkspaceModel | undefined,
): SelectionState {
  if (!kept) {
    return next;
  }

  const local = (ids: readonly string[]) =>
    ids.filter((id) => kept.assets.some((asset) => asset.id === id));

  return {
    subscriptions: [
      ...next.subscriptions,
      ...before.subscriptions.filter((s) => s.scope.id === kept.organizationId),
    ],
    individualAssetIds: [
      ...next.individualAssetIds,
      ...local(before.individualAssetIds),
    ],
    excludedAssetIds: [
      ...next.excludedAssetIds,
      ...local(before.excludedAssetIds),
    ],
    disabledAssetIds: [
      ...next.disabledAssetIds,
      ...local(before.disabledAssetIds),
    ],
  };
}

/** Publishes current content to a cloud workspace; Git history stays in the repo. */
export type MigrateOptions = { server: string; dryRun?: boolean };

/**
 * What `migrate` found and, unless `dryRun`, did. `migrated` is true once the
 * machine switched to the server.
 */
export type MigrationReport = {
  server: string;
  dryRun: boolean;
  rows: MigrationRow[];
  migrated: boolean;
};

/**
 * `migrate --to <server>`: publishes every asset and knowledge document of the
 * Git workspace to Cloud, then switches this machine's settings to the server,
 * translating the selection to Cloud IDs. Publishes nothing while any asset is
 * invalid or lacks its scope in Cloud. Takes the sync lock.
 */
export async function migrate(
  options: MigrateOptions,
  runtime: RuntimeContext,
): Promise<MigrationReport> {
  const { home } = runtime;

  return locked(runtime, async () => {
    const settings = await readSettings(home);
    if (!settings) {
      throw new SetupRequiredError();
    }

    const source = openRepoSource(settings, runtime);
    if (
      !settings.gitWorkspace &&
      settings.localWorkspace &&
      !settings.connection
    ) {
      throw new CliError(
        "`barndog migrate` moves a team's Git repo. To bring local assets to cloud, switch first: they stay active, and you can then move them with barndog local move.",
        "barndog init --server <url>",
      );
    }

    if (!source) {
      throw new CliError(
        "This machine isn't using a Git repo, so there's nothing to migrate.",
      );
    }

    const overlay = localOverlay(settings, runtime);
    const kept = overlay ? await overlay.model() : undefined;
    const model = await source.model();
    const server = normalizeServer(options.server);
    const conn = await connectionContext(server, runtime);
    const cloudScopes = await scopes(conn, runtime);

    const { catalog: existing } = await environmentCatalog(runtime, conn);
    const existingDocs = (
      await parsed(
        knowledgeIndexSchema,
        apiClient(conn.server, runtime).GET("/v1/knowledge", {
          params: { query: { limit: PAGE_SIZE } },
        }),
      )
    ).documents;

    const pairs = model.scopes.flatMap((local) => {
      const cloud = cloudScopes.find((scope) => sameScope(scope, local));

      return cloud ? [{ local, cloud }] : [];
    });

    const rows: MigrationRow[] = [];
    const pending: (() => Promise<unknown>)[] = [];
    for (const asset of model.assets) {
      const base = {
        kind: asset.kind,
        name: asset.name,
        origin: originLabel(asset.origin),
      };

      const pair = pairs.find((p) => p.local.id === asset.origin.id);
      if (asset.invalid) {
        rows.push({ ...base, action: "invalid", detail: asset.invalid });
      } else if (!pair) {
        rows.push({
          ...base,
          action: "missing-scope",
          detail: `Create ${originLabel(asset.origin)} in the workspace first`,
        });
      } else if (
        existing.assets.some(
          (a) =>
            a.kind === asset.kind &&
            a.name === asset.name &&
            a.origin.type === pair.cloud.type &&
            a.origin.id === pair.cloud.id,
        )
      ) {
        rows.push({ ...base, action: "exists" });
      } else {
        rows.push({ ...base, action: "publish" });
        pending.push(() =>
          asset.kind === "mcp"
            ? publishMcp(asset, pair.cloud, conn, runtime)
            : publishPackage(
                { ...asset, kind: asset.kind },
                pair.cloud,
                conn,
                runtime,
              ),
        );
      }
    }

    for (const doc of model.knowledge) {
      const base = { kind: "knowledge", name: doc.content.name, origin: "org" };
      if (existingDocs.some((d) => d.name === doc.content.name)) {
        rows.push({ ...base, action: "exists" });
      } else {
        rows.push({ ...base, action: "publish" });
        pending.push(() => publishKnowledge(doc, conn, runtime));
      }
    }

    if (options.dryRun) {
      return { server, dryRun: true, rows, migrated: false };
    }

    const blocked = rows.filter(
      (row) => row.action === "invalid" || row.action === "missing-scope",
    );

    if (blocked.length) {
      throw new CliError(
        `Nothing was published. Fix these first:\n${blocked.map((row) => `  ${row.origin}/${row.name}: ${row.detail}`).join("\n")}`,
        `barndog migrate --to ${server} --dry-run`,
      );
    }

    for (const publish of pending) {
      await publish();
    }

    const { catalog } = await environmentCatalog(runtime, conn);
    const next = withSelection(
      {
        ...settings,
        connection: conn,
        gitWorkspace: undefined,
      },
      keepLocalChoices(
        translateSelection(
          selectionState(settings),
          pairs,
          model.assets,
          catalog.assets,
        ),
        selectionState(settings),
        kept,
      ),
    );

    delete next.gitWorkspace;
    delete next.localNames;
    await saveSettings(next, home);
    await synchronize(undefined, runtime, next, { catalog });

    return { server, dryRun: false, rows, migrated: true };
  });
}
