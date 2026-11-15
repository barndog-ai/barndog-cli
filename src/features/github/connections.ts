/**
 * Connections between a Skill or Hook and a GitHub repository: connecting,
 * importing, mirroring and syncing. Every call goes to the BarnDog server,
 * never to GitHub itself.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  gitCopyImportSchema,
  gitCopyImportResultSchema,
  gitCreateRepositorySchema,
  gitRemoteHeadSchema,
  gitConnectionSchema,
  gitConnectSchema,
  gitImportSchema,
  gitMirrorResolutionSchema,
  okSchema,
  type GitConnection,
} from "@barndog-ai/api-contract";
import { selectOrigin } from "../server/origin.js";
import { connection } from "../server/connection.js";
import { selectAsset } from "../server/catalog.js";
import { type RetryKey, parsed } from "../server/client.js";
import { CliError } from "../../errors.js";
import type { PackageKind } from "../../config/selection.js";
import { apiClient } from "../auth/transport.js";

/** A BarnDog-owned copy of a repository, with no connection left behind. */
export type GitCopyImportResult = z.infer<typeof gitCopyImportResultSchema>;

/** The repository's main commit as GitHub reports it, and when that was observed. */
export type GitRemoteHead = z.infer<typeof gitRemoteHeadSchema>;

/** The server's acknowledgement that a diverged mirror was settled. */
export type MirrorResolved = z.infer<typeof okSchema>;

/** An asset and the GitHub repository it pairs with. */
export type GithubRepositoryOptions = {
  kind: PackageKind;
  name: string;
  origin: string;
  /** BarnDog's installation binding UUID, not GitHub's installation number. */
  installation: string;
  /** `<owner>/<name>` on GitHub. */
  repository: string;
};

/**
 * An asset to connect to an existing GitHub repository, and who stays
 * authoritative.
 */
export type GithubConnectOptions = GithubRepositoryOptions & {
  /** `mirror` keeps BarnDog authoritative; the others hand authority to GitHub. */
  mode?: "connect" | "transfer" | "mirror";
  /** Defaults to the asset's current version. */
  expectedVersion?: string;
};

/** A repository to copy once into a new BarnDog-owned asset. */
export type GithubImportCopyOptions = GithubRepositoryOptions & {
  key: RetryKey;
};

/**
 * A new GitHub repository for a published asset. `mode` defaults to `mirror`,
 * `visibility` to private.
 */
export type GithubCreateRepositoryOptions = GithubRepositoryOptions & {
  key: RetryKey;
  /** Defaults to the asset's current version. */
  expectedVersion?: string;
  mode?: "mirror" | "transfer";
  visibility?: "private" | "public";
};

/**
 * How to settle a mirror that diverged from BarnDog, refused if either side
 * moved since `expectedVersion` and `expectedRemoteCommit` were inspected. A
 * random retry key is used when `key` is left out.
 */
export type GithubResolveMirrorOptions = {
  connectionId: string;
  action: "use-barndog" | "use-mirror" | "disconnect";
  expectedVersion: string;
  /** Null when the remote main branch was inspected and is gone. */
  expectedRemoteCommit: string | null;
  key?: RetryKey;
};

/** The path parameters of one connection's routes; only a UUID may reach the URL. */
export const connectionParams = (connectionId: string) => ({
  path: { id: z.uuidv4().parse(connectionId) },
});

function repositoryTarget(options: GithubRepositoryOptions) {
  const [owner, repository, ...rest] = options.repository.split("/");
  if (!owner || !repository || rest.length) {
    throw new CliError("Choose the repository with --repository <owner/name>.");
  }

  return {
    kind: options.kind,
    installationId: options.installation,
    owner,
    repository,
  };
}

export async function githubList(home: string): Promise<GitConnection[]> {
  const conn = await connection(home);

  return parsed(
    z.array(gitConnectionSchema),
    apiClient(conn.server, home).GET("/v1/git-connections"),
  );
}

/** Connects a published Skill or Hook to an existing GitHub repository. */
export async function githubConnect(
  options: GithubConnectOptions,
  home: string,
): Promise<GitConnection> {
  const conn = await connection(home);
  const target = repositoryTarget(options);
  const selected = await selectAsset(
    target.kind,
    options.name,
    options.origin,
    home,
  );

  const body = gitConnectSchema.parse({
    ...target,
    assetId: selected.reference.id,
    expectedVersionId: options.expectedVersion ?? selected.asset.version.id,
    mode: options.mode ?? "connect",
  });

  return parsed(
    gitConnectionSchema,
    apiClient(conn.server, home).POST("/v1/git-connections", { body }),
  );
}

/** Creates a Skill or Hook from a GitHub repository, which stays authoritative. */
export async function githubImport(
  options: GithubRepositoryOptions,
  home: string,
): Promise<GitConnection> {
  const conn = await connection(home);
  const target = repositoryTarget(options);
  const scope = await selectOrigin(options.origin, conn, home);
  const body = gitImportSchema.parse({
    ...target,
    name: options.name,
    origin: { type: scope.type, id: scope.id },
  });

  return parsed(
    gitConnectionSchema,
    apiClient(conn.server, home).POST("/v1/git-connections/import", { body }),
  );
}

/** Copies a GitHub repository into a BarnDog-owned asset with no connection left behind. */
export async function githubImportCopy(
  options: GithubImportCopyOptions,
  home: string,
): Promise<GitCopyImportResult> {
  const conn = await connection(home);
  const target = repositoryTarget(options);
  const scope = await selectOrigin(options.origin, conn, home);
  const body = gitCopyImportSchema.parse({
    ...target,
    name: options.name,
    origin: { type: scope.type, id: scope.id },
    idempotencyKey: options.key,
  });

  return parsed(
    gitCopyImportResultSchema,
    apiClient(conn.server, home).POST("/v1/git-connections/import-copy", {
      body,
    }),
  );
}

/** Creates a GitHub repository for a published asset and exports its history. */
export async function githubCreateRepository(
  options: GithubCreateRepositoryOptions,
  home: string,
): Promise<GitConnection> {
  const conn = await connection(home);
  const target = repositoryTarget(options);
  const selected = await selectAsset(
    target.kind,
    options.name,
    options.origin,
    home,
  );

  const body = gitCreateRepositorySchema.parse({
    ...target,
    assetId: selected.reference.id,
    expectedVersionId: options.expectedVersion ?? selected.asset.version.id,
    mode: options.mode ?? "mirror",
    visibility: options.visibility ?? "private",
    idempotencyKey: options.key,
  });

  return parsed(
    gitConnectionSchema,
    apiClient(conn.server, home).POST("/v1/git-connections/create-repository", {
      body,
    }),
  );
}

export async function githubShow(
  connectionId: string,
  home: string,
): Promise<GitConnection> {
  const conn = await connection(home);

  return parsed(
    gitConnectionSchema,
    apiClient(conn.server, home).GET("/v1/git-connections/{id}", {
      params: connectionParams(connectionId),
    }),
  );
}

/** Syncs now instead of waiting for the server's next scheduled sync. */
export async function githubSync(
  connectionId: string,
  home: string,
): Promise<GitConnection> {
  const conn = await connection(home);

  return parsed(
    gitConnectionSchema,
    apiClient(conn.server, home).POST("/v1/git-connections/{id}/sync", {
      params: connectionParams(connectionId),
    }),
  );
}

/** The repository's main commit as GitHub reports it now, not as last synced. */
export async function githubRemoteHead(
  connectionId: string,
  home: string,
): Promise<GitRemoteHead> {
  const conn = await connection(home);

  return parsed(
    gitRemoteHeadSchema,
    apiClient(conn.server, home).GET("/v1/git-connections/{id}/remote-head", {
      params: connectionParams(connectionId),
    }),
  );
}

/** Settles a mirror that diverged from BarnDog; refused if either side moved since it was inspected. */
export async function githubResolveMirror(
  options: GithubResolveMirrorOptions,
  home: string,
): Promise<MirrorResolved> {
  const conn = await connection(home);
  const body = gitMirrorResolutionSchema.parse({
    action: options.action,
    expectedVersionId: options.expectedVersion,
    expectedRemoteCommit: options.expectedRemoteCommit,
    idempotencyKey: options.key ?? randomUUID(),
  });

  return parsed(
    okSchema,
    apiClient(conn.server, home).POST(
      "/v1/git-connections/{id}/mirror-resolution",
      { params: connectionParams(options.connectionId), body },
    ),
  );
}
