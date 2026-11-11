import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  ApiError,
  gitConnectionSchema,
  gitPullSchema,
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
import { metadata as packageMetadataFor } from "./domain.js";
import { download } from "./remote.js";
import { request, getAsset } from "../environment/remote.js";
import {
  encodeFiles,
  decodeFiles,
  save,
  applyFiles,
  type Workspace,
} from "./workspace-store.js";

export async function externalSource(work: Workspace, home: string) {
  if (!work.skillId) return undefined;
  const connections = await request(
    work.connection,
    "/v1/git-connections",
    z.array(gitConnectionSchema),
    home,
  );
  const source = connections.find(
    (c) =>
      c.assetId === work.skillId &&
      c.kind === work.kind &&
      c.authority === "github",
  );
  if (work.external && (!source || source.id !== work.external.id))
    throw new Error(
      "External content authority changed; preserve this working copy and pull a new one",
    );
  if (source && source.status !== "active")
    throw new Error(
      `GitHub synchronization requires attention: ${source.lastError ?? source.status}`,
    );
  if (source && work.pending)
    throw new Error(
      "An internal submission is pending; resolve it before using GitHub",
    );
  return source;
}

type ExternalSource = z.infer<typeof gitConnectionSchema>;

export async function pullExternal(
  work: Workspace,
  source: ExternalSource,
  entries: PackageEntry[],
  previous: Workspace,
  home: string,
) {
  work.external ??= { id: source.id };
  const conflicts = new Set<string>(),
    external = work.external;
  if (external.pull) {
    const { pull } = await request(
      work.connection,
      `/v1/git-connections/${source.id}/pulls/${external.pull.number}`,
      gitPullDetailsSchema,
      home,
    );
    if (pull.head !== external.pull.head) {
      const remote = await download(
        `/v1/git-connections/${source.id}/pulls/${pull.number}/package`,
        work.connection,
        home,
        pull.head,
        work.kind,
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
    if (pull.merged) delete external.pull;
  }
  const asset = await getAsset(work.kind, work.skillId!, work.connection, home);
  if (!("commit" in asset.version))
    throw new Error("Expected a Git-backed package version");
  if (asset.version.id !== work.baseVersionId) {
    const latest = await download(
      `/v1/skills/${work.skillId}/versions/${asset.version.number}/package`,
      work.connection,
      home,
      asset.version.commit,
      work.kind,
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

export async function pushExternal(
  work: Workspace,
  source: ExternalSource,
  options: { publish?: boolean; new?: boolean; title?: string },
  home: string,
) {
  work.external ??= { id: source.id };
  const external = work.external,
    path = `/v1/git-connections/${source.id}`;
  if (!external.pending) {
    const asset = await getAsset(
      work.kind,
      work.skillId!,
      work.connection,
      home,
    );
    if (asset.version.id !== work.baseVersionId)
      throw new Error(
        "Published GitHub content changed; run barndog pull before pushing",
      );
    let pull = external.pull
      ? (
          await request(
            work.connection,
            `${path}/pulls/${external.pull.number}`,
            gitPullDetailsSchema,
            home,
          )
        ).pull
      : undefined;
    if (pull?.state === "closed" && !options.new)
      throw new Error(
        "Pull request is closed; run barndog pull, then push --new to contribute again",
      );
    if (pull && pull.head !== external.pull!.head)
      throw new Error(
        "Pull request changed remotely; run barndog pull before pushing",
      );
    if (options.new) pull = undefined;
    const files = await readDirectory(work.root);
    if (packageMetadataFor(files, work.kind).name !== work.name)
      throw new Error("Package name cannot change in this working copy");
    const previous = pull ? external.pull!.files : work.base;
    if (
      packageFingerprint(files) === packageFingerprint(decodeFiles(previous)) &&
      !options.title
    ) {
      if (options.publish && pull)
        return request(
          work.connection,
          `${path}/pulls/${pull.number}/merge`,
          gitConnectionSchema,
          home,
          "PUT",
          { expectedCommit: pull.head },
        );
      return { unchanged: true, pull: pull?.number };
    }
    external.pending = {
      number: pull?.number,
      expectedCommit: pull?.head ?? source.syncedCommit!,
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
      home,
      pending.number ? "PUT" : "POST",
      {
        expectedCommit: pending.expectedCommit,
        files: pending.files,
        title: pending.title,
        idempotencyKey: pending.idempotencyKey,
      },
    );
  } catch (error) {
    if (
      error instanceof ApiError &&
      [400, 403, 404, 409, 413].includes(error.status)
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
  if (options.publish)
    return request(
      work.connection,
      `${path}/pulls/${pull.number}/merge`,
      gitConnectionSchema,
      home,
      "PUT",
      { expectedCommit: external.pull.head },
    );
  return pull;
}
