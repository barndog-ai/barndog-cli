import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename } from "node:path";

import type { KnowledgeContent, McpDefinition } from "@barndog-ai/api-contract";
import type { PackageEntry } from "@barndog-ai/api-contract/package";
import { knowledgeIndexSchema, scopeSchema } from "@barndog-ai/api-contract";
import { stringify } from "yaml";
import { z } from "zod";

import {
  readSettings,
  SetupRequiredError,
  type Connection,
  type GitWorkspace,
} from "../../config/settings.js";
import { CliError, friendlyMessage } from "../../errors.js";
import {
  connection,
  matchesOrigin,
  selectOrigin,
} from "../collaboration/remote.js";
import { selectScope } from "../collaboration/workspace-git.js";
import { renameSkillEntries } from "../environment/installed.js";
import { originLabel } from "../environment/names.js";
import { environmentCatalog, request } from "../environment/remote.js";
import { synchronize } from "../environment/sync.js";
import { locked } from "../environment/transaction.js";
import { assetPath, stableId, type RepoAsset } from "./format.js";
import { checkRepositoryUrl, cloneOrigin, git } from "./git.js";
import {
  connectGitWorkspace,
  createGitWorkspace,
  inspectRepository,
} from "./setup.js";
import { LoginRequiredError, normalizeServer } from "../auth/transport.js";
import { connectionContext } from "../skills/remote.js";
import { publishKnowledge, publishMcp, publishPackage } from "./migrate.js";
import { readMoved, recordMoved } from "./overlay.js";
import { commitFiles, openPullRequest, pushCommit } from "./publish.js";
import {
  acceptedCommit,
  gitDirectory,
  gitRepoSource,
  localRepoSource,
  recordFetch,
  trackingRef,
  type RepoSource,
} from "./source.js";
import { defined } from "../../shared/lookup.js";
import { setYamlName } from "../../shared/patterns.js";

export type MoveRow = {
  kind: string;
  name: string;
  status: "moved" | "clash" | "skipped" | "failed";
  detail?: string;
};

export type MoveResult = {
  target: string;
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
async function repoDestination(value: string, home: string) {
  const url = checkRepositoryUrl(await cloneOrigin(value));
  const head = await inspectRepository(url);

  return head
    ? connectGitWorkspace(url, head.branch, home)
    : createGitWorkspace(
        url,
        basename(url).replace(/\.git$/, "") || "Workspace",
        home,
      );
}

async function serverDestination(value: string, home: string) {
  const server = normalizeServer(value);
  try {
    return await connectionContext(server, home);
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
    if (
      !items.some((item) => item.path.includes(`/${name}`)) &&
      !invalid.some((row) => row.name === name)
    ) {
      throw new CliError(`No local asset named ${name}.`, "barndog local list");
    }
  }

  return { items, invalid };
}

function knowledgeFile(content: KnowledgeContent) {
  const { description, tags, accessMode, markdown } = content;

  return `---\n${stringify({ description, tags, accessMode })}---\n${markdown}`;
}

async function moveToGit(
  workspace: GitWorkspace,
  items: Candidate[],
  to: string | undefined,
  home: string,
): Promise<MoveResult> {
  const shared = await gitRepoSource(workspace, home).model();
  const tip = defined(
    await acceptedCommit(workspace.workspaceId, home),
    "This Git workspace hasn't been fetched yet",
  );

  const scope = selectScope(shared, to ?? "org");
  const repo = gitDirectory(workspace.workspaceId, home);
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
      files:
        item.kind === "knowledge"
          ? [
              {
                path,
                data: Buffer.from(knowledgeFile(knowledgeOf(item))),
                executable: false,
              },
            ]
          : item.kind === "mcp"
            ? [
                {
                  path,
                  data: Buffer.from(stringify(item.definition)),
                  executable: false,
                },
              ]
            : item.entries.map((entry) => ({
                ...entry,
                path: `${path}/${entry.path}`,
              })),
    });
  }

  const result: MoveResult = {
    target: workspace.url,
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
    { files: moving.flatMap((entry) => entry.files) },
    title,
  );

  // A workspace with nothing in it has nothing to review against.
  if (!shared.assets.length && !shared.knowledge.length) {
    await pushCommit(repo, commit, workspace.branch);
    await git(["update-ref", trackingRef(workspace.branch), commit], { repo });
    await recordFetch(workspace, commit, home);
    result.direct = true;
    result.branch = workspace.branch;
  } else {
    const branch = `barndog/local-move-${randomBytes(3).toString("hex")}`;
    await pushCommit(repo, commit, branch);
    const opened = await openPullRequest({
      url: workspace.url,
      base: workspace.branch,
      branch,
      title,
    });

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

  return result;
}

async function moveToCloud(
  conn: Connection,
  items: Candidate[],
  to: string | undefined,
  home: string,
): Promise<MoveResult> {
  const scope = await selectOrigin(to ?? "me", conn, home);
  if (!scope.canPublish) {
    throw new CliError(
      `You can't publish to ${originLabel(scope)}.`,
      "barndog local move --to me",
    );
  }

  const { catalog } = await environmentCatalog(home, conn);
  const docs = (
    await request(conn, "/v1/knowledge?limit=100", knowledgeIndexSchema, home)
  ).documents;

  const scopes = await request(conn, "/v1/scopes", z.array(scopeSchema), home);
  const org = scopes.find((s) => s.type === "org");
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
            home,
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
        await publishMcp(asset, scope, conn, home);
      } else {
        await publishPackage({ ...asset, kind: asset.kind }, scope, conn, home);
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

  return { target: originLabel(scope), rows, originId: scope.id };
}

/** Copies local assets into the shared workspace; the local folder is never deleted. */
export function moveLocalAssets(
  options: {
    names?: string[];
    to?: string;
    as?: string;
    repo?: string;
    server?: string;
    kind?: string;
  },
  home = homedir(),
): Promise<MoveResult> {
  return locked(home, async () => {
    const settings = await readSettings(home);
    if (!settings) {
      throw new SetupRequiredError();
    }

    if (!settings.localWorkspace) {
      throw new CliError("This machine has no local assets to move.");
    }

    const overlay = localRepoSource(settings.localWorkspace, home);
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

    const result = options.repo
      ? await moveToGit(
          await repoDestination(options.repo, home),
          items,
          options.to,
          home,
        )
      : options.server
        ? await moveToCloud(
            await serverDestination(options.server, home),
            items,
            options.to,
            home,
          )
        : settings.gitWorkspace
          ? await moveToGit(settings.gitWorkspace, items, options.to, home)
          : await moveToCloud(await connection(home), items, options.to, home);

    result.rows.unshift(...invalid);
    const moved = result.rows.filter((row) => row.status === "moved");
    await recordMoved(
      overlay.label,
      moved.map((row) => ({
        kind: row.kind,
        name: row.name,
        ...(row.kind !== "knowledge" ? { originId: result.originId } : {}),
        path: defined(
          items.find((i) => i.kind === row.kind && i.name === row.name),
          `${row.name} isn't among the moved items`,
        ).path,
      })),
    );

    if (moved.length) {
      await synchronize(undefined, home, undefined, { prompt: false });
    }

    return result;
  });
}

export async function listLocalAssets(home = homedir()) {
  const settings = await readSettings(home);
  if (!settings || !settings.localWorkspace) {
    throw new CliError(
      "This machine has no local assets.",
      "barndog init --local",
    );
  }

  const source = localRepoSource(settings.localWorkspace, home);
  const model = await source.model();
  const moved = await readMoved(source.label);
  const state = (path: string, invalid?: string) =>
    invalid
      ? "invalid"
      : moved.some((m) => m.path === path)
        ? "moved"
        : "active";

  return {
    folder: settings.localWorkspace.path,
    assets: [
      ...model.assets.map((asset) => ({
        kind: asset.kind,
        name: asset.name,
        path: asset.path,
        state: state(asset.path, asset.invalid),
      })),
      ...model.knowledge.map((doc) => ({
        kind: "knowledge",
        name: doc.content.name,
        path: doc.path,
        state: state(doc.path),
      })),
    ],
  };
}

/** Where setup can offer to send local assets in a Cloud Workspace; personal first. */
export async function cloudMoveTargets(home: string) {
  const conn = await connection(home);
  const scopes = await request(conn, "/v1/scopes", z.array(scopeSchema), home);

  return scopes
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
