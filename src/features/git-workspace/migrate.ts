import { homedir } from "node:os";

import {
  changeSchema,
  mcpSchema,
  knowledgeDocumentSchema,
  knowledgeIndexSchema,
  scopeSchema,
  type ChangeUpload,
} from "@barndog-ai/api-contract";
import { z } from "zod";

import { selectionState, withSelection } from "../../config/environment.js";
import {
  readSettings,
  saveSettings,
  SetupRequiredError,
  upgradeSettings,
  type Connection,
} from "../../config/settings.js";
import { CliError } from "../../errors.js";
import type {
  AssetReference,
  SelectionState,
} from "../asset-selection/types.js";
import { normalizeServer } from "../auth/transport.js";
import { collaborationClient } from "../collaboration/domain.js";
import { archive } from "../collaboration/workspace.js";
import { encodeFiles } from "../collaboration/workspace-store.js";
import { originLabel } from "../environment/names.js";
import { environmentCatalog, request } from "../environment/remote.js";
import { synchronize } from "../environment/sync.js";
import { locked } from "../environment/transaction.js";
import { openRepoSource } from "../environment/workspace-source.js";
import { connectionContext } from "../skills/remote.js";
import type {
  RepoAsset,
  RepoKnowledge,
  RepoScope,
  WorkspaceModel,
} from "./format.js";
import { localOverlay } from "./overlay.js";

export type MigrationRow = {
  kind: string;
  name: string;
  origin: string;
  action: "publish" | "exists" | "invalid" | "missing-scope";
  detail?: string;
};

type CloudScope = z.infer<typeof scopeSchema>;

export type PublishableAsset = Pick<
  RepoAsset,
  "id" | "kind" | "name" | "publishedVersion" | "entries" | "definition"
>;

const sameScope = (cloud: CloudScope, local: RepoScope) =>
  cloud.type === local.type &&
  (local.type === "org" || cloud.slug === local.slug);

export async function publishPackage(
  asset: PublishableAsset,
  scope: CloudScope,
  conn: Connection,
  home: string,
) {
  const kind = asset.kind === "hook" ? "hook" : "skill";
  const client = collaborationClient(conn.server, home, kind);
  const files = encodeFiles(asset.entries);
  const metadata: ChangeUpload = {
    name: asset.name,
    origin: { type: scope.type, id: scope.id },
    baseVersionId: null,
    title: `Migrate ${asset.name} from Git`,
    // Stable per content, so re-running after a failure repeats rather than duplicates.
    idempotencyKey: `migrate-${asset.id}-${asset.publishedVersion}-${scope.id}-${asset.name}`,
  };
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  form.set("package", await archive(files, home), "skill.tar.gz");
  const change = changeSchema.parse(
    (await client.POST("/v1/skill-changes", { body: form })).data,
  );
  await client.POST("/v1/skill-changes/{id}/merge", {
    params: { path: { id: change.id } },
    body: { expectedRevision: change.submittedRevision },
  });
}

export const publishMcp = (
  asset: PublishableAsset,
  scope: CloudScope,
  conn: Connection,
  home: string,
) =>
  request(conn, "/v1/mcps", mcpSchema, home, "POST", {
    name: asset.name,
    origin: { type: scope.type, id: scope.id },
    definition: asset.definition,
    idempotencyKey: `migrate-${asset.id}-${asset.publishedVersion}-${scope.id}-${asset.name}`,
  });

export const publishKnowledge = (
  doc: Pick<RepoKnowledge, "id" | "version" | "content">,
  conn: Connection,
  home: string,
) =>
  request(
    conn,
    "/v1/knowledge/publish",
    knowledgeDocumentSchema,
    home,
    "POST",
    {
      baseVersionId: null,
      content: doc.content,
      idempotencyKey: `migrate-${doc.id}-${doc.version}-${doc.content.name}`,
    },
  );

/** Carries each choice over by scope and name, because cloud assigns new IDs. */
function translateSelection(
  state: SelectionState,
  scopes: { local: RepoScope; cloud: CloudScope }[],
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
  if (!kept) return next;
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
export async function migrate(
  options: { server: string; dryRun?: boolean },
  home = homedir(),
): Promise<{
  server: string;
  dryRun: boolean;
  rows: MigrationRow[];
  migrated: boolean;
}> {
  return locked(home, async () => {
    const settings = await readSettings(home);
    if (!settings) throw new SetupRequiredError();
    const source = openRepoSource(settings, home);
    if (
      settings.version === 2 &&
      !settings.gitWorkspace &&
      settings.localWorkspace &&
      !settings.connection
    )
      throw new CliError(
        "`barndog migrate` moves a team's Git repo. To bring local assets to cloud, switch first: they stay active, and you can then move them with barndog local move.",
        "barndog init --server <url>",
      );
    if (!source)
      throw new CliError(
        "This machine isn't using a Git repo, so there's nothing to migrate.",
      );
    const overlay = localOverlay(settings, home);
    const kept = overlay ? await overlay.model() : undefined;
    const model = await source.model();
    const server = normalizeServer(options.server);
    const conn = await connectionContext(server, home);
    const cloudScopes = await request(
      conn,
      "/v1/scopes",
      z.array(scopeSchema),
      home,
    );
    const { catalog: existing } = await environmentCatalog(home, conn);
    const existingDocs = (
      await request(conn, "/v1/knowledge?limit=100", knowledgeIndexSchema, home)
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
      if (asset.invalid)
        rows.push({ ...base, action: "invalid", detail: asset.invalid });
      else if (!pair)
        rows.push({
          ...base,
          action: "missing-scope",
          detail: `Create ${originLabel(asset.origin)} in the workspace first`,
        });
      else if (
        existing.assets.some(
          (a) =>
            a.kind === asset.kind &&
            a.name === asset.name &&
            a.origin.type === pair.cloud.type &&
            a.origin.id === pair.cloud.id,
        )
      )
        rows.push({ ...base, action: "exists" });
      else {
        rows.push({ ...base, action: "publish" });
        pending.push(() =>
          asset.kind === "mcp"
            ? publishMcp(asset, pair.cloud, conn, home)
            : publishPackage(asset, pair.cloud, conn, home),
        );
      }
    }
    for (const doc of model.knowledge) {
      const base = { kind: "knowledge", name: doc.content.name, origin: "org" };
      if (existingDocs.some((d) => d.name === doc.content.name))
        rows.push({ ...base, action: "exists" });
      else {
        rows.push({ ...base, action: "publish" });
        pending.push(() => publishKnowledge(doc, conn, home));
      }
    }
    if (options.dryRun) return { server, dryRun: true, rows, migrated: false };
    const blocked = rows.filter(
      (row) => row.action === "invalid" || row.action === "missing-scope",
    );
    if (blocked.length)
      throw new CliError(
        `Nothing was published. Fix these first:\n${blocked.map((row) => `  ${row.origin}/${row.name}: ${row.detail}`).join("\n")}`,
        `barndog migrate --to ${server} --dry-run`,
      );
    for (const publish of pending) await publish();
    const { catalog } = await environmentCatalog(home, conn);
    const upgraded = upgradeSettings(settings);
    const next = withSelection(
      {
        ...upgraded,
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
    await synchronize(undefined, home, next, { catalog });
    return { server, dryRun: false, rows, migrated: true };
  });
}
