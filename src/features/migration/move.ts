import type { RuntimeContext } from "../../runtime.js";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { rm } from "node:fs/promises";

import {
  type KnowledgeContent,
  type McpDefinition,
  knowledgeIndexSchema,
} from "@barndog-ai/api-contract";
import type { PackageEntry } from "@barndog-ai/api-contract/package";
import type { AssetKind } from "../../config/selection.js";
import { stringify } from "yaml";

import {
  readSettings,
  SetupRequiredError,
  type Connection,
  type GitWorkspace,
} from "../../config/settings.js";
import { CliError, friendlyMessage } from "../../errors.js";
import { matchesOrigin, selectOrigin, scopes } from "../server/origin.js";
import { connection } from "../server/connection.js";
import { selectScope } from "../collaboration/workspace-git.js";
import { renameSkillEntries } from "../workspace/installed.js";
import { originLabel } from "../server/origin.js";
import { environmentCatalog } from "../server/catalog.js";
import { parsed } from "../server/client.js";
import { synchronize } from "../environment/sync.js";
import { locked } from "../environment/transaction.js";
import {
  assetPath,
  repoAssetId,
  stableId,
  type RepoAsset,
} from "../workspace/format.js";
import {
  updateKeptValues,
  withMovedServers,
} from "../environment/kept-values.js";
import { checkRepositoryUrl, cloneOrigin, git } from "../workspace/git.js";
import {
  connectGitWorkspace,
  createGitWorkspace,
  inspectRepository,
} from "../workspace/setup.js";
import {
  LoginRequiredError,
  normalizeServer,
  apiClient,
} from "../auth/transport.js";
import { connectionContext } from "../auth/session.js";
import { publishKnowledge, publishMcp, publishPackage } from "./migrate.js";
import {
  moveDestination,
  readMoved,
  recordMoved,
  type MovedAsset,
} from "../workspace/overlay.js";
import {
  commitFiles,
  openPullRequest,
  pushCommit,
} from "../workspace/publish.js";
import {
  acceptedCommit,
  gitRepoSource,
  localRepoSource,
  recordFetch,
  trackingRef,
  type RepoSource,
} from "../workspace/repo-source.js";
import { defined } from "../../shared/lookup.js";
import { setYamlName } from "../../shared/patterns.js";
import { barndogPaths } from "../../config/paths.js";
import { PAGE_SIZE } from "../server/pages.js";

/** Three random bytes distinguish temporary move branches. */
const MOVE_BRANCH_RANDOM_BYTES = 3;

type MoveRow = {
  kind: string;
  name: string;
  status: "moved" | "clash" | "skipped" | "failed";
  detail?: string;
};

/** Which local assets to move, and where. */
export type MoveOptions = {
  /** Every local asset not already moving when absent. */
  names?: string[];
  /**
   * True copies them and leaves the local assets as they are. False makes the
   * shared copy the only one: the local copy goes once the shared one exists.
   */
  keepLocal: boolean;
  to?: string;
  as?: string;
  repo?: string;
  server?: string;
  kind?: string;
};

export type MoveResult = {
  target: string;
  keepLocal: boolean;
  /** Local knowledge files deleted at once, because their shared copy already exists. */
  removed: string[];
  /** The scope moved assets now belong to. */
  originId?: string;
  rows: MoveRow[];
  branch?: string;
  url?: string | null;
  direct?: boolean;
};

type Candidate = {
  kind: "skill" | "hook" | "mcp" | "knowledge";
  name: string;
  path: string;
  version: string;
  id: string;
  entries: PackageEntry[];
  definition?: McpDefinition;
  content?: KnowledgeContent;
};

const knowledgeOf = (item: Candidate) =>
  defined(item.content, `${item.name} has no knowledge content`);

/** A one-off destination: nothing about this machine's own setup changes. */
async function repoDestination(value: string, runtime: RuntimeContext) {
  const url = checkRepositoryUrl(await cloneOrigin(value, runtime));
  const head = await inspectRepository(url, runtime);

  return head
    ? connectGitWorkspace(url, head.branch, runtime)
    : createGitWorkspace(
        url,
        basename(url).replace(/\.git$/, "") || "Workspace",
        runtime,
      );
}

async function serverDestination(value: string, runtime: RuntimeContext) {
  const server = normalizeServer(value);
  try {
    return await connectionContext(server, runtime);
  } catch (error) {
    if (error instanceof LoginRequiredError) {
      throw new CliError(
        `Sign in to ${server} first. This machine stays local.`,
        `barndog login --server ${server}`,
        { cause: error },
      );
    }

    throw error;
  }
}

function renamed(asset: RepoAsset, name: string): PackageEntry[] {
  if (asset.name === name) {
    return asset.entries;
  }

  if (asset.kind === "skill") {
    return renameSkillEntries(asset.entries, name);
  }

  return asset.entries.map((entry) =>
    entry.path === "hook.yaml"
      ? {
          ...entry,
          data: Buffer.from(setYamlName(entry.data.toString("utf8"), name)),
        }
      : entry,
  );
}

async function candidates(
  overlay: RepoSource,
  names: string[] | undefined,
  as: string | undefined,
  kind?: string,
) {
  const model = await overlay.model();
  const moved = await readMoved(overlay.label);
  const pending = (path: string) =>
    names?.length ? true : !moved.some((entry) => entry.path === path);

  const items: Candidate[] = [];
  const invalid: MoveRow[] = [];
  // Requested names, as the local workspace spells them, that matched an asset.
  const found = new Set<string>();
  for (const asset of model.assets) {
    if (
      !pending(asset.path) ||
      (names?.length && !names.includes(asset.name)) ||
      (kind && asset.kind !== kind)
    ) {
      continue;
    }

    if (asset.invalid) {
      invalid.push({
        kind: asset.kind,
        name: asset.name,
        status: "skipped",
        detail: asset.invalid,
      });

      continue;
    }

    found.add(asset.name);
    const name = as ?? asset.name;
    items.push({
      kind: asset.kind,
      name,
      path: asset.path,
      version: asset.publishedVersion,
      id: asset.id,
      entries: renamed(asset, name),
      definition: asset.definition,
    });
  }

  for (const doc of model.knowledge) {
    if (
      !pending(doc.path) ||
      (names?.length && !names.includes(doc.content.name))
    ) {
      continue;
    }

    found.add(doc.content.name);
    const name = as ?? doc.content.name;
    items.push({
      kind: "knowledge",
      name,
      path: doc.path,
      version: doc.version,
      id: doc.id,
      entries: [],
      content: { ...doc.content, name },
    });
  }

  for (const name of names ?? []) {
    if (!found.has(name) && !invalid.some((row) => row.name === name)) {
      throw new CliError(`No local asset named ${name}.`, "barndog local list");
    }
  }

  return { items, invalid };
}

function knowledgeFile(content: KnowledgeContent) {
  const { description, tags, accessMode, markdown } = content;

  return `---\n${stringify({ description, tags, accessMode })}---\n${markdown}`;
}

/** The files a candidate becomes in a Git workspace, under `path`. */
function candidateFiles(
  item: Candidate,
  path: string,
): { path: string; data: Buffer; executable: boolean }[] {
  if (item.kind === "knowledge") {
    return [
      {
        path,
        data: Buffer.from(knowledgeFile(knowledgeOf(item))),
        executable: false,
      },
    ];
  }

  if (item.kind === "mcp") {
    return [
      {
        path,
        data: Buffer.from(stringify(item.definition)),
        executable: false,
      },
    ];
  }

  return item.entries.map((entry) => ({
    ...entry,
    path: `${path}/${entry.path}`,
  }));
}

/**
 * Each moved MCP server's local asset ID → its shared copy's, filled in by a
 * move as it copies them, so kept values can follow a copy that stays local.
 */
type SharedIds = Map<string, string>;

/** The assets to copy into a shared workspace, and the scope to copy them to. */
type CopyRequest = {
  items: Candidate[];
  to: string | undefined;
  sharedIds?: SharedIds;
};

async function moveToGit(
  workspace: GitWorkspace,
  move: CopyRequest,
  runtime: RuntimeContext,
): Promise<MoveResult> {
  const { items, to, sharedIds = new Map<string, string>() } = move;
  const { home } = runtime;

  const shared = await gitRepoSource(workspace, runtime).model();
  const tip = defined(
    await acceptedCommit(workspace.workspaceId, runtime),
    "This Git workspace hasn't been fetched yet",
  );

  const scope = selectScope(shared, to ?? "org");
  const repo = barndogPaths(home).bareClone(workspace.workspaceId);
  const rows: MoveRow[] = [];
  const moving: {
    item: Candidate;
    files: { path: string; data: Buffer; executable: boolean }[];
  }[] = [];

  for (const item of items) {
    const path =
      item.kind === "knowledge"
        ? `org/knowledge/${item.name}.md`
        : assetPath(scope.path, item.kind, item.name);

    if (
      shared.assets.some((asset) => asset.path === path) ||
      shared.knowledge.some((doc) => doc.path === path)
    ) {
      rows.push({
        kind: item.kind,
        name: item.name,
        status: "clash",
        detail: `${path} already exists`,
      });

      continue;
    }

    moving.push({
      item,
      files: candidateFiles(item, path),
    });
  }

  const result: MoveResult = {
    target: workspace.url,
    keepLocal: true,
    removed: [],
    rows,
    originId: stableId(
      workspace.workspaceId,
      "scope",
      scope.type,
      ...(scope.type === "org" ? [] : [scope.slug]),
    ),
  };

  if (!moving.length) {
    return result;
  }

  const title = `Move ${moving.length} local asset${moving.length === 1 ? "" : "s"} into the workspace`;
  const commit = await commitFiles(
    repo,
    tip,
    {
      files: moving.flatMap((entry) => entry.files),
      message: title,
    },
    { ...{}, runtime },
  );

  // A workspace with nothing in it has nothing to review against.
  if (!shared.assets.length && !shared.knowledge.length) {
    await pushCommit(repo, commit, workspace.branch, {
      runtime,
      allowPrompt: false,
    });

    await git(["update-ref", trackingRef(workspace.branch), commit], runtime, {
      repo,
    });

    await recordFetch(workspace, commit, runtime);
    result.direct = true;
    result.branch = workspace.branch;
  } else {
    const branch = `barndog/local-move-${randomBytes(MOVE_BRANCH_RANDOM_BYTES).toString("hex")}`;
    await pushCommit(repo, commit, branch, {
      runtime,
      allowPrompt: false,
    });

    const opened = await openPullRequest(
      {
        url: workspace.url,
        base: workspace.branch,
        branch,
        title,
      },
      runtime,
    );

    result.branch = branch;
    result.url = opened.url ?? null;
  }

  rows.push(
    ...moving.map(({ item }) => ({
      kind: item.kind,
      name: item.name,
      status: "moved" as const,
    })),
  );

  for (const { item } of moving) {
    if (item.kind === "mcp") {
      sharedIds.set(
        item.id,
        repoAssetId(workspace.workspaceId, "mcp", scope, item.name),
      );
    }
  }

  return result;
}

async function moveToCloud(
  conn: Connection,
  move: CopyRequest,
  runtime: RuntimeContext,
): Promise<MoveResult> {
  const { items, to, sharedIds = new Map<string, string>() } = move;
  const scope = await selectOrigin(to ?? "me", conn, runtime);
  if (!scope.canPublish) {
    throw new CliError(
      `You can't publish to ${originLabel(scope)}.`,
      "barndog local move --to me",
    );
  }

  const { catalog } = await environmentCatalog(runtime, conn);
  const docs = (
    await parsed(
      knowledgeIndexSchema,
      apiClient(conn.server, runtime).GET("/v1/knowledge", {
        params: { query: { limit: PAGE_SIZE } },
      }),
    )
  ).documents;

  const visible = await scopes(conn, runtime);
  const org = visible.find((s) => s.type === "org");
  const rows: MoveRow[] = [];
  for (const item of items) {
    const base = { kind: item.kind, name: item.name };
    try {
      if (item.kind === "knowledge") {
        if (docs.some((doc) => doc.name === item.name)) {
          rows.push({ ...base, status: "clash", detail: "Name already used" });
        } else if (!org?.canPublish) {
          rows.push({
            ...base,
            status: "skipped",
            detail:
              "Knowledge is organization-wide, and you can't publish there",
          });
        } else {
          await publishKnowledge(
            {
              id: item.id,
              version: item.version,
              content: knowledgeOf(item),
            },
            conn,
            runtime,
          );

          rows.push({ ...base, status: "moved" });
        }

        continue;
      }

      if (
        catalog.assets.some(
          (asset) =>
            asset.kind === item.kind &&
            asset.name === item.name &&
            asset.origin.id === scope.id,
        )
      ) {
        rows.push({
          ...base,
          status: "clash",
          detail: `Already in ${originLabel(scope)}`,
        });

        continue;
      }

      const asset = {
        id: item.id,
        kind: item.kind,
        name: item.name,
        publishedVersion: item.version,
        entries: item.entries,
        definition: item.definition,
      };

      if (asset.kind === "mcp") {
        sharedIds.set(
          item.id,
          (await publishMcp(asset, scope, conn, runtime)).id,
        );
      } else {
        await publishPackage(
          { ...asset, kind: asset.kind },
          scope,
          conn,
          runtime,
        );
      }

      rows.push({ ...base, status: "moved" });
    } catch (error) {
      rows.push({
        ...base,
        status: "failed",
        detail: friendlyMessage(error),
      });
    }
  }

  return {
    target: originLabel(scope),
    keepLocal: true,
    removed: [],
    rows,
    originId: scope.id,
    direct: true,
  };
}

/**
 * A shared copy that sits beside its local server starts with the local one's
 * kept values; after that each keeps its own. A full move carries them over
 * when sync finishes it (`environment/moves.ts`).
 */
async function copyKeptValues(sharedIds: SharedIds, runtime: RuntimeContext) {
  const copies = [...sharedIds].map(([from, to]) => ({ from, to, copy: true }));
  if (!copies.length) {
    return;
  }

  await updateKeptValues(
    (secrets) => withMovedServers(secrets, copies),
    runtime,
  );
}

/** A one-off destination (`--repo`, `--server`) leaves this machine as it is, so it only copies. */
const keepsLocal = (options: MoveOptions) =>
  options.keepLocal || Boolean(options.repo ?? options.server);

/**
 * Records full moves so sync can replace each local copy with the shared one
 * once it exists. Knowledge that is already published needs no selection, so
 * its local file goes at once; the rest waits for the next sync.
 */
async function finishMove(
  folder: string,
  result: MoveResult,
  moved: MoveRow[],
  items: Candidate[],
) {
  const removed: string[] = [];
  const records: MovedAsset[] = [];
  for (const row of moved) {
    const item = defined(
      items.find((i) => i.kind === row.kind && i.name === row.name),
      `${row.name} isn't among the moved items`,
    );

    if (row.kind === "knowledge" && result.direct) {
      const path = join(folder, item.path);
      await rm(path, { force: true });
      removed.push(path);
      continue;
    }

    records.push({
      kind: row.kind,
      name: row.name,
      path: item.path,
      version: item.version,
      target: result.target,
      ...(row.kind !== "knowledge" ? { originId: result.originId } : {}),
      ...(result.url ? { url: result.url } : {}),
    });
  }

  await recordMoved(folder, records);

  return removed;
}

/**
 * Copies local assets into the shared workspace. With `keepLocal` false the
 * shared copy becomes the only one: sync removes each local copy once its
 * shared copy exists.
 */
export function moveLocalAssets(
  options: MoveOptions,
  runtime: RuntimeContext,
): Promise<MoveResult> {
  const { home } = runtime;

  return locked(runtime, async () => {
    const settings = await readSettings(home);
    if (!settings) {
      throw new SetupRequiredError();
    }

    if (!settings.localWorkspace) {
      throw new CliError("This machine has no local assets to move.");
    }

    const overlay = localRepoSource(settings.localWorkspace, runtime);
    const shared =
      options.repo || options.server
        ? null
        : (settings.gitWorkspace ?? settings.connection);

    if (!options.repo && !options.server && !shared) {
      throw new CliError(
        "This machine only has its local folder, so there's nowhere to move assets yet. Name a Git repo or a Cloud Workspace as the destination; this machine stays local.",
        "barndog local move --repo <url> or barndog local move --server <url>",
      );
    }

    if (options.as && options.names?.length !== 1) {
      throw new CliError(
        "--as renames one asset, so name exactly one.",
        "barndog local move <name> --as <new-name>",
      );
    }

    const { items, invalid } = await candidates(
      overlay,
      options.names,
      options.as,
      options.kind,
    );

    // Only this machine's own workspace: a one-off destination isn't installed here.
    const sharedIds: SharedIds = new Map();
    const moveItems = async () => {
      if (options.repo) {
        return moveToGit(
          await repoDestination(options.repo, runtime),
          { items, to: options.to },
          runtime,
        );
      }

      if (options.server) {
        return moveToCloud(
          await serverDestination(options.server, runtime),
          { items, to: options.to },
          runtime,
        );
      }

      if (settings.gitWorkspace) {
        return moveToGit(
          settings.gitWorkspace,
          { items, to: options.to, sharedIds },
          runtime,
        );
      }

      return moveToCloud(
        await connection(runtime),
        { items, to: options.to, sharedIds },
        runtime,
      );
    };

    const result = await moveItems();

    result.rows.unshift(...invalid);
    result.keepLocal = keepsLocal(options);

    const moved = result.rows.filter((row) => row.status === "moved");
    if (!result.keepLocal) {
      result.removed = await finishMove(overlay.label, result, moved, items);
    } else {
      await copyKeptValues(sharedIds, runtime);
    }

    if (moved.length) {
      await synchronize(undefined, runtime, undefined, { prompt: false });
    }

    return result;
  });
}

/**
 * `available` is valid and can be installed or moved; whether it is installed
 * is up to the selection. `moving` while a full move waits for its shared copy,
 * such as a pull request to merge; the local copy stays in use until then.
 */
type LocalAssetState = "available" | "moving" | "invalid";

/** The local folder and every asset and knowledge document in it. */
export type LocalAssets = {
  folder: string;
  assets: {
    kind: AssetKind | "knowledge";
    name: string;
    path: string;
    state: LocalAssetState;
    /** Where a moving asset is going: its pull request, else the destination. */
    movingTo?: string;
  }[];
};

export async function listLocalAssets(
  runtime: RuntimeContext,
): Promise<LocalAssets> {
  const { home } = runtime;

  const settings = await readSettings(home);
  if (!settings || !settings.localWorkspace) {
    throw new CliError(
      "This machine has no local assets.",
      "barndog init --local",
    );
  }

  const source = localRepoSource(settings.localWorkspace, runtime);
  const model = await source.model();
  // A move can only be under way while the workspace it goes to is in use.
  const moving =
    settings.connection || settings.gitWorkspace
      ? await readMoved(source.label)
      : [];

  const state = (path: string, invalid?: string) => {
    if (invalid) {
      return { state: "invalid" as const };
    }

    const entry = moving.find((m) => m.path === path);

    return entry
      ? {
          state: "moving" as const,
          movingTo: moveDestination(entry),
        }
      : { state: "available" as const };
  };

  return {
    folder: settings.localWorkspace.path,
    assets: [
      ...model.assets.map((asset) => ({
        kind: asset.kind,
        name: asset.name,
        path: asset.path,
        ...state(asset.path, asset.invalid),
      })),
      ...model.knowledge.map((doc) => ({
        kind: "knowledge" as const,
        name: doc.content.name,
        path: doc.path,
        ...state(doc.path),
      })),
    ],
  };
}

/** Where setup can offer to send local assets in a Cloud Workspace; personal first. */
export async function cloudMoveTargets(runtime: RuntimeContext) {
  const conn = await connection(runtime);
  const visible = await scopes(conn, runtime);

  return visible
    .filter(
      (s) => s.canPublish && (s.type !== "dev" || matchesOrigin(s, "me", conn)),
    )
    .sort((a, b) => Number(b.type === "dev") - Number(a.type === "dev"))
    .map((s) => ({
      value: s.type === "dev" ? "me" : originLabel(s),
      name:
        s.type === "dev"
          ? "Your personal assets"
          : `${s.name} (${originLabel(s)})`,
    }));
}
