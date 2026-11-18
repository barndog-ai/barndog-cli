import { fixSteps } from "../../platform.js";
import type { RuntimeContext } from "../../runtime.js";
import { HTTP_STATUS } from "../../shared/constants.js";

import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  ApiError,
  gitConnectionSchema,
  gitPullSchema,
  type GitConnection,
  gitPullDetailsSchema,
  gitProposalSchema,
  gitRevisionSchema,
} from "@barndog-ai/api-contract";
import {
  packageFingerprint,
  type PackageEntry,
} from "@barndog-ai/api-contract/package";
import { mergeEntries } from "@barndog-ai/api-contract/collaboration";
import { metadata as packageMetadataFor } from "../asset-kinds/index.js";
import { downloadPull, downloadVersion } from "./remote.js";
import { getAsset } from "../server/catalog.js";
import { parsed } from "../server/client.js";
import {
  encodeFiles,
  decodeFiles,
  save,
  applyFiles,
  type Workspace,
  readWorkingCopy,
} from "./workspace-store.js";
import { defined } from "../../shared/lookup.js";

import type { CloudPushResult, UpdatedCloudWorkingCopy } from "./results.js";
import { CliError } from "../../errors.js";
import { apiClient } from "../auth/transport.js";

const publishedId = (work: { assetId?: string | null }) =>
  defined(work.assetId, "This working copy isn't published yet");

/**
 * The GitHub connection that is authoritative for this working copy's asset, if
 * any. Throws when the authority changed since the copy was made, when the
 * connection needs attention, or when an internal upload is still pending.
 */
export async function externalSource(work: Workspace, runtime: RuntimeContext) {
  if (!work.assetId) {
    return undefined;
  }

  const connections = await parsed(
    z.array(gitConnectionSchema),
    apiClient(work.connection.server, runtime).GET("/v1/git-connections"),
  );

  const source = connections.find(
    (c) =>
      c.assetId === work.assetId &&
      c.kind === work.kind &&
      c.authority === "github",
  );

  if (work.external && (!source || source.id !== work.external.id)) {
    throw new CliError(
      "This asset's GitHub connection changed on the server. Save your edits elsewhere, then pull a fresh working copy.",
      "barndog pull",
    );
  }

  if (source && source.status !== "active") {
    throw new CliError(
      `GitHub sync needs attention: ${source.lastError ?? source.status}.`,
      "barndog github list",
    );
  }

  if (source && work.pending) {
    throw new CliError(
      "A push to BarnDog is still waiting for confirmation. Retry it before using GitHub.",
      "barndog push",
    );
  }

  return source;
}

/**
 * `pull` for a GitHub-authoritative asset: merges edits made to its pull
 * request, then newly published main content, into the folder.
 */
export async function pullExternal(
  work: Workspace,
  {
    source,
    entries,
    previous,
  }: { source: GitConnection; entries: PackageEntry[]; previous: Workspace },
  runtime: RuntimeContext,
): Promise<UpdatedCloudWorkingCopy> {
  work.external ??= { id: source.id };
  const conflicts = new Set<string>();
  const external = work.external;

  if (external.pull) {
    const { pull } = await parsed(
      gitPullDetailsSchema,
      apiClient(work.connection.server, runtime).GET(
        "/v1/git-connections/{id}/pulls/{number}",
        { params: { path: { id: source.id, number: external.pull.number } } },
      ),
    );

    if (pull.head !== external.pull.head) {
      const remote = await downloadPull(
        { connectionId: source.id, number: pull.number, head: pull.head },
        work.connection,
        { runtime, kind: work.kind },
      );

      const merged = await mergeEntries(
        decodeFiles(external.pull.files),
        entries,
        remote,
      );

      entries = merged.entries;
      merged.conflicts.forEach((p) => conflicts.add(p));
      external.pull = {
        number: pull.number,
        head: pull.head,
        files: encodeFiles(remote),
      };
    }

    if (pull.merged) {
      delete external.pull;
    }
  }

  const asset = await getAsset(
    work.kind,
    publishedId(work),
    work.connection,
    runtime,
  );

  if (!("commit" in asset.version)) {
    throw new Error(
      "The server returned a GitHub-connected version without its Git commit",
    );
  }

  if (asset.version.id !== work.baseVersionId) {
    const latest = await downloadVersion(
      {
        id: publishedId(work),
        number: asset.version.number,
        commit: asset.version.commit,
      },
      work.connection,
      { runtime, kind: work.kind },
    );

    const merged = await mergeEntries(decodeFiles(work.base), entries, latest);
    entries = merged.entries;
    merged.conflicts.forEach((p) => conflicts.add(p));
    work.base = encodeFiles(latest);
    work.baseVersionId = asset.version.id;
    work.baseNumber = asset.version.number;
  }

  work.conflicts = [...conflicts];
  await applyFiles(work, entries, runtime, previous);

  return {
    root: work.root,
    conflicts: work.conflicts,
    baseVersion: work.baseNumber,
    external: { connectionId: source.id, pull: external.pull?.number },
  };
}

/**
 * `push` for a GitHub-authoritative asset: opens or revises its pull request
 * with the complete package and, with `publish`, merges it. The request and
 * retry key are saved first so an ambiguous failure retries exactly; a
 * definitive refusal (400, 403, 404, 409, 413) drops it so local edits can be
 * reconciled.
 */
export async function pushExternal(
  work: Workspace,
  source: GitConnection,
  options: { publish?: boolean; new?: boolean; title?: string },
  runtime: RuntimeContext,
): Promise<CloudPushResult> {
  work.external ??= { id: source.id };
  const external = work.external;
  const client = apiClient(work.connection.server, runtime);
  const merge = (number: number, expectedCommit: string) =>
    parsed(
      gitConnectionSchema,
      client.PUT("/v1/git-connections/{id}/pulls/{number}/merge", {
        params: { path: { id: source.id, number } },
        body: { expectedCommit },
      }),
    );

  if (!external.pending) {
    const asset = await getAsset(
      work.kind,
      publishedId(work),
      work.connection,
      runtime,
    );

    if (asset.version.id !== work.baseVersionId) {
      throw new CliError(
        "The published content on GitHub changed since your last pull.",
        "barndog pull",
      );
    }

    let pull = external.pull
      ? (
          await parsed(
            gitPullDetailsSchema,
            client.GET("/v1/git-connections/{id}/pulls/{number}", {
              params: {
                path: { id: source.id, number: external.pull.number },
              },
            }),
          )
        ).pull
      : undefined;

    if (pull?.state === "closed" && !options.new) {
      throw new CliError(
        "The pull request is closed. Pull, then push a new one.",
        fixSteps(["barndog pull", "barndog push --new"], runtime.platform),
      );
    }

    if (pull && pull.head !== external.pull?.head) {
      throw new CliError(
        "The pull request changed on GitHub since your last pull.",
        "barndog pull",
      );
    }

    if (options.new) {
      pull = undefined;
    }

    const files = await readWorkingCopy(work, runtime);
    if (packageMetadataFor(files, work.kind).name !== work.name) {
      throw new CliError(
        `This working copy's name must stay ${work.name}. Change it back, then push again.`,
      );
    }

    const previous = (pull && external.pull?.files) || work.base;
    if (
      packageFingerprint(files) === packageFingerprint(decodeFiles(previous)) &&
      !options.title
    ) {
      if (options.publish && pull) {
        return merge(pull.number, pull.head);
      }

      return { unchanged: true, pull: pull?.number };
    }

    external.pending = {
      number: pull?.number,
      expectedCommit:
        pull?.head ??
        defined(source.syncedCommit, "This connection hasn't synced yet"),
      files: encodeFiles(files),
      title: options.title ?? `Update ${work.name}`,
      idempotencyKey: randomUUID(),
    };

    await save(work, runtime);
  }

  const pending = external.pending;
  let pull;
  try {
    const body = {
      expectedCommit: pending.expectedCommit,
      files: pending.files,
      title: pending.title,
      idempotencyKey: pending.idempotencyKey,
    };

    pull = await parsed(
      gitPullSchema,
      pending.number
        ? client.PUT("/v1/git-connections/{id}/pulls/{number}/revisions", {
            params: { path: { id: source.id, number: pending.number } },
            body: gitRevisionSchema.parse(body),
          })
        : client.POST("/v1/git-connections/{id}/pulls", {
            params: { path: { id: source.id } },
            body: gitProposalSchema.parse(body),
          }),
    );
  } catch (error) {
    if (
      error instanceof ApiError &&
      [
        HTTP_STATUS.badRequest,
        HTTP_STATUS.forbidden,
        HTTP_STATUS.notFound,
        HTTP_STATUS.conflict,
        HTTP_STATUS.payloadTooLarge,
      ].includes(error.status)
    ) {
      delete external.pending;
      await save(work, runtime);
    }

    throw error;
  }

  external.pull = {
    number: pull.number,
    head: pull.submittedCommit ?? pull.head,
    files: pending.files,
  };

  delete external.pending;
  await save(work, runtime);
  if (options.publish) {
    return merge(pull.number, external.pull.head);
  }

  return pull;
}
