import { HTTP_STATUS } from "../../shared/constants.js";

import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  ApiError,
  gitConnectionSchema,
  gitPullSchema,
  type GitConnection,
  gitPullDetailsSchema,
} from "@barndog-ai/api-contract";
import {
  packageFingerprint,
  type PackageEntry,
} from "@barndog-ai/api-contract/package";
import {
  mergeEntries,
  readDirectory,
} from "@barndog-ai/api-contract/collaboration";
import { metadata as packageMetadataFor } from "../asset-kinds/index.js";
import { download } from "./remote.js";
import { getAsset } from "../server/catalog.js";
import { request } from "../server/request.js";
import {
  encodeFiles,
  decodeFiles,
  save,
  applyFiles,
  type Workspace,
} from "./workspace-store.js";
import { defined } from "../../shared/lookup.js";

import type { CloudPushResult, UpdatedCloudWorkingCopy } from "./results.js";
import { CliError } from "../../errors.js";

const publishedId = (work: { skillId?: string | null }) =>
  defined(work.skillId, "This working copy isn't published yet");

/**
 * The GitHub connection that is authoritative for this working copy's asset, if
 * any. Throws when the authority changed since the copy was made, when the
 * connection needs attention, or when an internal upload is still pending.
 */
export async function externalSource(work: Workspace, home: string) {
  if (!work.skillId) {
    return undefined;
  }

  const connections = await request(
    work.connection,
    "/v1/git-connections",
    z.array(gitConnectionSchema),
    { home },
  );

  const source = connections.find(
    (c) =>
      c.assetId === work.skillId &&
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
  home: string,
): Promise<UpdatedCloudWorkingCopy> {
  work.external ??= { id: source.id };
  const conflicts = new Set<string>();
  const external = work.external;

  if (external.pull) {
    const { pull } = await request(
      work.connection,
      `/v1/git-connections/${source.id}/pulls/${external.pull.number}`,
      gitPullDetailsSchema,
      { home },
    );

    if (pull.head !== external.pull.head) {
      const remote = await download(
        `/v1/git-connections/${source.id}/pulls/${pull.number}/package`,
        work.connection,
        { home, commit: pull.head, kind: work.kind },
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
    home,
  );

  if (!("commit" in asset.version)) {
    throw new Error(
      "The server returned a GitHub-connected version without its Git commit",
    );
  }

  if (asset.version.id !== work.baseVersionId) {
    const latest = await download(
      `/v1/skills/${work.skillId}/versions/${asset.version.number}/package`,
      work.connection,
      { home, commit: asset.version.commit, kind: work.kind },
    );

    const merged = await mergeEntries(decodeFiles(work.base), entries, latest);
    entries = merged.entries;
    merged.conflicts.forEach((p) => conflicts.add(p));
    work.base = encodeFiles(latest);
    work.baseVersionId = asset.version.id;
    work.baseNumber = asset.version.number;
  }

  work.conflicts = [...conflicts];
  await applyFiles(work, entries, home, previous);

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
  home: string,
): Promise<CloudPushResult> {
  work.external ??= { id: source.id };
  const external = work.external;
  const path = `/v1/git-connections/${source.id}`;

  if (!external.pending) {
    const asset = await getAsset(
      work.kind,
      publishedId(work),
      work.connection,
      home,
    );

    if (asset.version.id !== work.baseVersionId) {
      throw new CliError(
        "The published content on GitHub changed since your last pull.",
        "barndog pull",
      );
    }

    let pull = external.pull
      ? (
          await request(
            work.connection,
            `${path}/pulls/${external.pull.number}`,
            gitPullDetailsSchema,
            { home },
          )
        ).pull
      : undefined;

    if (pull?.state === "closed" && !options.new) {
      throw new CliError(
        "The pull request is closed. Pull, then push a new one.",
        "barndog pull && barndog push --new",
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

    const files = await readDirectory(work.root);
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
        return request(
          work.connection,
          `${path}/pulls/${pull.number}/merge`,
          gitConnectionSchema,
          { home, method: "PUT", body: { expectedCommit: pull.head } },
        );
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

    await save(work, home);
  }

  const pending = external.pending;
  let pull;
  try {
    pull = await request(
      work.connection,
      pending.number
        ? `${path}/pulls/${pending.number}/revisions`
        : `${path}/pulls`,
      gitPullSchema,
      {
        home,
        method: pending.number ? "PUT" : "POST",
        body: {
          expectedCommit: pending.expectedCommit,
          files: pending.files,
          title: pending.title,
          idempotencyKey: pending.idempotencyKey,
        },
      },
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
      await save(work, home);
    }

    throw error;
  }

  external.pull = {
    number: pull.number,
    head: pull.submittedCommit ?? pull.head,
    files: pending.files,
  };

  delete external.pending;
  await save(work, home);
  if (options.publish) {
    return request(
      work.connection,
      `${path}/pulls/${pull.number}/merge`,
      gitConnectionSchema,
      { home, method: "PUT", body: { expectedCommit: external.pull.head } },
    );
  }

  return pull;
}
