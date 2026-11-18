import { isWindows } from "../../platform.js";
import { writePackage, readDirectory } from "../workspace/directory.js";
import type { RuntimeContext } from "../../runtime.js";
import { HTTP_STATUS } from "../../shared/constants.js";

import { randomUUID } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";

import { c } from "tar";
import { ApiError } from "@barndog-ai/api-contract";
import {
  defaultLimits,
  packageFingerprint,
} from "@barndog-ai/api-contract/package";
import {
  diffEntries,
  mergeEntries,
  textContent,
} from "@barndog-ai/api-contract/collaboration";
import { packageApi } from "./api.js";
import { changeAssetId, type PackageChange } from "./results.js";
import {
  metadata as packageMetadataFor,
  packageKindOf,
  assetKinds,
} from "../asset-kinds/index.js";
import { type PackageKind } from "../../config/selection.js";
import {
  downloadChange,
  downloadVersion,
  getChange,
  selectPackage,
} from "./remote.js";
import { selectOrigin } from "../server/origin.js";
import { connection } from "../server/connection.js";

import {
  encodeFiles,
  decodeFiles,
  save,
  locked,
  find,
  applyFiles,
  type Workspace,
  type Files,
  NoWorkingCopyError,
  type PackageUpload,
  readWorkingCopy,
} from "./workspace-store.js";
import {
  externalSource,
  pullExternal,
  pushExternal,
} from "./workspace-github.js";

import { defined } from "../../shared/lookup.js";
import { NAME } from "../../shared/patterns.js";

import type {
  CloudPushResult,
  CloudWorkingCopyStatus,
  ConflictResolution,
  CreatedPackage,
  PulledPackage,
  UpdatedCloudWorkingCopy,
} from "./results.js";
import { CliError, PackageError } from "../../errors.js";
import { barndogPaths } from "../../config/paths.js";

const publishedId = (work: { assetId?: string | null }) =>
  defined(work.assetId, "This working copy isn't published yet");

const linkedProposal = <P>(work: { proposal?: P | null }) =>
  defined(work.proposal, "This working copy has no linked proposal");

const publishedVersion = (change: PackageChange) =>
  defined(
    change.publishedVersion,
    "The merged change has no published version",
  );

export { NoWorkingCopyError } from "./workspace-store.js";

/** Where a new working folder goes. */
export type WorkingFolderOptions = {
  /** The new folder; defaults to `./<name>`. */
  target?: string;
  runtime: RuntimeContext;
};

/**
 * `pull <name>` in Cloud: downloads the published Skill or Hook into a new
 * working folder (`target`, default `./<name>`) and registers it under
 * `~/.barndog/workspaces/`. Refuses a folder that already exists.
 */
export async function pullCloudPackage(
  { name, origin, kind }: { name: string; origin: string; kind: PackageKind },
  { target, runtime }: WorkingFolderOptions,
): Promise<PulledPackage> {
  const { cwd } = runtime;

  return locked(runtime, async () => {
    const conn = await connection(runtime);
    const published = await selectPackage(
      { name, selector: origin, kind },
      conn,
      runtime,
    );

    const path = resolve(cwd, target ?? name);
    await mkdir(dirname(path), { recursive: true });
    // Never overwrite an existing directory, even if it appears empty.
    await mkdir(path);
    const root = await realpath(path);
    try {
      const files = await downloadVersion(
        {
          id: published.id,
          number: published.version.number,
          commit: published.version.commit,
        },
        conn,
        { runtime, kind },
      );

      await writePackage(root, files, runtime);
      await save(
        {
          root,
          kind,
          connection: conn,
          assetId: published.id,
          name: published.name,
          origin: { type: published.origin.type, id: published.origin.id },
          baseVersionId: published.version.id,
          baseNumber: published.version.number,
          base: encodeFiles(files),
          conflicts: [],
        },
        runtime,
      );

      return { root, version: published.version.number };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  });
}

/**
 * The Cloud working copy containing `cwd`, with its edits as diffs against the
 * version it started from. Throws `NoWorkingCopyError` outside one.
 */
export async function workspaceStatus(
  runtime: RuntimeContext,
): Promise<CloudWorkingCopyStatus> {
  return locked(runtime, async () => {
    const work = await find(runtime);
    const local = await readWorkingCopy(work, runtime);

    return {
      root: work.root,
      name: work.name,
      baseVersion: work.baseNumber,
      proposal: work.proposal
        ? { id: work.proposal.id, revision: work.proposal.revision }
        : null,
      conflicts: work.conflicts,
      pending: !!work.pending || !!work.external?.pending,
      external: work.external
        ? {
            connectionId: work.external.id,
            pull: work.external.pull
              ? {
                  number: work.external.pull.number,
                  head: work.external.pull.head,
                }
              : null,
          }
        : null,
      changes: await diffEntries(decodeFiles(work.base), local),
    };
  });
}

/**
 * `pull` in a Cloud working copy: merges edits made to its open proposal, then
 * the newest published version, into the folder. Hands over to GitHub
 * reconciliation when GitHub is authoritative. Refuses while a submission
 * awaits a retry; conflicting text gets markers and is listed in `conflicts`.
 */
export async function updateWorkspace(
  runtime: RuntimeContext,
): Promise<UpdatedCloudWorkingCopy> {
  return locked(runtime, async () => {
    const work = await find(runtime);
    const previous = structuredClone(work);
    await connection(runtime, work.connection);
    if (work.pending || work.external?.pending) {
      throw new CliError(
        "Your last push is still waiting for the server to confirm it. Retry it before pulling.",
        "barndog push",
      );
    }

    if (work.conflicts.length) {
      throw new CliError(
        "Resolve the existing conflicts before pulling again.",
        "barndog resolve <path>",
      );
    }

    let entries = await readWorkingCopy(work, runtime);
    const conflicts = new Set<string>();
    const source = await externalSource(work, runtime);
    if (source) {
      return pullExternal(work, { source, entries, previous }, runtime);
    }

    if (work.proposal) {
      const proposal = await getChange(
        work.proposal.id,
        work.connection,
        runtime,
        work.kind,
      );

      if (proposal.revision !== work.proposal.revision) {
        const remote = await downloadChange(proposal, work.connection, {
          runtime,
          kind: work.kind,
        });

        const merged = await mergeEntries(
          decodeFiles(work.proposal.files),
          entries,
          remote,
        );

        entries = merged.entries;
        merged.conflicts.forEach((p) => conflicts.add(p));
        // The author's remote proposal may already have been rebased by another client.
        if (proposal.baseVersionId !== work.baseVersionId) {
          if (proposal.baseVersionId) {
            const versions = await packageApi(
              work.kind,
              work.connection,
              runtime,
            ).versions(publishedId(work));

            const version = versions.find(
              (v) => v.id === proposal.baseVersionId,
            );

            if (!version) {
              throw new Error(
                "The server didn't return the version this Suggested Change is based on",
              );
            }

            work.base = encodeFiles(
              await downloadVersion(
                {
                  id: publishedId(work),
                  number: version.number,
                  commit: version.commit,
                },
                work.connection,
                { runtime, kind: work.kind },
              ),
            );

            work.baseNumber = version.number;
          } else {
            work.base = [];
            work.baseNumber = null;
          }

          work.baseVersionId = proposal.baseVersionId;
        }

        work.proposal = {
          id: proposal.id,
          revision: proposal.revision,
          files: encodeFiles(remote),
        };
      }
    }

    if (work.baseVersionId) {
      const published = await packageApi(
        work.kind,
        work.connection,
        runtime,
      ).published(publishedId(work));

      if (published.version.id !== work.baseVersionId) {
        const latest = await downloadVersion(
          {
            id: published.id,
            number: published.version.number,
            commit: published.version.commit,
          },
          work.connection,
          { runtime, kind: work.kind },
        );

        const merged = await mergeEntries(
          decodeFiles(work.base),
          entries,
          latest,
        );

        entries = merged.entries;
        merged.conflicts.forEach((p) => conflicts.add(p));
        work.base = encodeFiles(latest);
        work.baseVersionId = published.version.id;
        work.baseNumber = published.version.number;
      }
    } else if (work.proposal) {
      const proposal = await getChange(
        work.proposal.id,
        work.connection,
        runtime,
        work.kind,
      );

      if (proposal.publishedVersion) {
        work.baseVersionId = proposal.publishedVersion.id;
        work.baseNumber = proposal.publishedVersion.number;
        work.base = work.proposal.files;
      }
    }

    work.conflicts = [...conflicts];
    await applyFiles(work, entries, runtime, previous);

    return {
      root: work.root,
      conflicts: work.conflicts,
      baseVersion: work.baseNumber,
    };
  });
}

/**
 * Marks one conflicted file in a Cloud working copy resolved, after checking
 * its conflict markers are gone.
 */
export async function resolveConflict(
  path: string,
  runtime: RuntimeContext,
): Promise<ConflictResolution> {
  return locked(runtime, async () => {
    const work = await find(runtime);

    return markResolved(work, path, runtime);
  });
}

/**
 * A line a three-way merge writes around conflicting text: `<<<<<<< local`,
 * `||||||| base`, `=======` or `>>>>>>> remote` (seven characters, then a space
 * and a label or the end of the line).
 */
const CONFLICT_MARKER = /^(?:<{7}|\|{7}|={7}|>{7})(?: |$)/m;

/**
 * Whether text still holds a line the three-way merge wrote around a conflict.
 *
 * @internal Exported for its table test in `src/tests/patterns.test.ts`.
 */
export const hasConflictMarkers = (text: string) => CONFLICT_MARKER.test(text);

/** Clears one conflict once its markers are gone; shared by cloud and Git working copies. */
/**
 * The conflict `absolute` names. macOS and Windows folders usually ignore
 * case, so there a path that differs only in case still matches, as long as
 * it matches one conflict.
 */
function conflictAt(
  work: Pick<Workspace, "root" | "conflicts">,
  absolute: string,
  platform: NodeJS.Platform,
) {
  const exact = work.conflicts.find((p) => join(work.root, p) === absolute);
  if (exact || (platform !== "darwin" && !isWindows(platform))) {
    return exact;
  }

  const folded = absolute.toLowerCase();
  const matches = work.conflicts.filter(
    (p) => join(work.root, p).toLowerCase() === folded,
  );

  return matches.length === 1 ? matches[0] : undefined;
}

export async function markResolved(
  work: Pick<
    Workspace,
    "root" | "conflicts" | "pendingWrite" | "pendingSnapshot"
  >,
  path: string,
  runtime: RuntimeContext,
) {
  const { cwd } = runtime;

  const absolute = resolve(await realpath(cwd), path);
  const conflict = conflictAt(work, absolute, runtime.platform);
  if (!conflict) {
    throw new CliError(
      `${path} isn't an unresolved conflict.`,
      "barndog status",
    );
  }

  const files = await readDirectory(work.root, runtime);
  const file = files.find((e) => e.path === conflict);

  if (file && hasConflictMarkers(textContent(file.data) ?? "")) {
    throw new CliError(
      `${conflict} still has conflict markers. Edit them out, then resolve it again.`,
      `barndog resolve ${path}`,
    );
  }

  const paths = new Set(files.map((e) => e.path));
  for (const p of paths) {
    if ([...paths].some((other) => p.startsWith(other + "/"))) {
      throw new CliError(
        `A file and a folder share the path ${p}. Keep one, then resolve again.`,
        `barndog resolve ${path}`,
      );
    }
  }

  work.conflicts = work.conflicts.filter((p) => p !== conflict);
  await save(work, runtime);

  return { resolved: conflict, remaining: work.conflicts };
}

/**
 * Packs base64-encoded files into the gzipped tarball the server's upload
 * routes take. Fails with `PACKAGE_TOO_LARGE` above the compressed size limit;
 * uses a temporary folder under `~/.barndog/workspaces/`.
 */
export async function archive(files: Files, runtime: RuntimeContext) {
  const { home } = runtime;

  const temp = join(barndogPaths(home).workingCopies, `upload-${randomUUID()}`);
  const tar = temp + ".tar.gz";

  try {
    await writePackage(temp, decodeFiles(files), runtime);
    await c(
      { cwd: temp, file: tar, gzip: true, portable: true, noMtime: true },
      files.map((e) => e.path),
    );

    const bytes = await readFile(tar);
    if (bytes.length > defaultLimits.compressed) {
      throw new PackageError("PACKAGE_TOO_LARGE");
    }

    return new Blob([bytes]);
  } finally {
    await rm(temp, { recursive: true, force: true });
    await rm(tar, { force: true });
  }
}

/**
 * `push` in Cloud: creates or revises the working copy's proposal and, with
 * `publish`, merges it at once (scope or organization admins and personal
 * owners only). Inside
 * a folder that isn't a working copy yet, `origin` registers it first. The
 * upload, retry key and payload are saved before sending, so an ambiguous
 * failure can be retried exactly. GitHub-authoritative assets go to a pull
 * request instead.
 */
export async function pushWorkspace(
  options: {
    origin?: string;
    kind?: PackageKind;
    name?: string;
    publish?: boolean;
    new?: boolean;
    title?: string;
  } = {},
  runtime: RuntimeContext,
): Promise<CloudPushResult> {
  const { cwd } = runtime;

  return locked(runtime, async () => {
    let work: Workspace;
    let unregistered = false;
    try {
      work = await find(runtime);
    } catch (error) {
      if (!options.origin || !(error instanceof NoWorkingCopyError)) {
        throw error;
      }

      const conn = await connection(runtime);
      const root = await realpath(cwd);
      const files = await readDirectory(root, runtime);
      const kind = packageKindOf(files, options.kind);
      const description = packageMetadataFor(files, kind);

      const origin = await selectOrigin(options.origin, conn, runtime);
      work = {
        root,
        kind,
        connection: conn,
        name: description.name,
        origin: { type: origin.type, id: origin.id },
        baseVersionId: null,
        baseNumber: null,
        base: [],
        conflicts: [],
      };

      unregistered = true;
    }

    if (options.kind && work.kind !== options.kind) {
      throw new CliError(
        `This working copy holds a ${work.kind}, not a ${options.kind}.`,
        "barndog status",
      );
    }

    if (options.name && work.name !== options.name) {
      throw new CliError(
        `This working copy is ${work.name}, not ${options.name}.`,
        "barndog status",
      );
    }

    // Registered only once the folder passed the checks above.
    if (unregistered) {
      await save(work, runtime);
    }

    await connection(runtime, work.connection);
    if (options.origin) {
      const selected = await selectOrigin(
        options.origin,
        work.connection,
        runtime,
      );

      if (
        selected.type !== work.origin.type ||
        selected.id !== work.origin.id
      ) {
        if (work.assetId || work.proposal || work.pending) {
          throw new CliError(
            "This working copy was already submitted, so its origin can't change. Push without --origin.",
            "barndog push",
          );
        }

        work.origin = { type: selected.type, id: selected.id };
        await save(work, runtime);
      }
    }

    if (work.conflicts.length) {
      throw new CliError(
        "Resolve the conflicts before pushing.",
        "barndog resolve <path>",
      );
    }

    const source = await externalSource(work, runtime);
    if (source) {
      return pushExternal(work, source, options, runtime);
    }

    const api = packageApi(work.kind, work.connection, runtime);
    if (options.publish) {
      const scope = await selectOrigin(
        `${work.origin.type}:${work.origin.id}`,
        work.connection,
        runtime,
      );

      if (!scope.canPublish) {
        throw new CliError(
          `Only a scope admin, an organization admin or the personal owner can publish directly. Propose it for review instead, then merge it with barndog ${assetKinds[work.kind].command} changes merge.`,
          "barndog push",
        );
      }
    }

    let proposal = work.proposal
      ? await getChange(work.proposal.id, work.connection, runtime, work.kind)
      : undefined;

    if (
      !work.pending &&
      options.publish &&
      proposal?.status === "merged" &&
      proposal.publishedVersion &&
      packageFingerprint(await readWorkingCopy(work, runtime)) ===
        packageFingerprint(decodeFiles(linkedProposal(work).files))
    ) {
      work.baseVersionId = proposal.publishedVersion.id;
      work.baseNumber = proposal.publishedVersion.number;
      work.base = linkedProposal(work).files;
      await save(work, runtime);

      return proposal;
    }

    if (!work.pending) {
      if (proposal?.status === "rejected" && !options.new) {
        throw new CliError(
          "This Suggested Change was rejected.",
          "barndog push --new",
        );
      }

      if (
        proposal?.status === "merged" &&
        proposal.publishedVersion?.id !== work.baseVersionId
      ) {
        throw new CliError(
          "Your last Suggested Change was merged. Pull it before starting another.",
          "barndog pull",
        );
      }

      if (
        proposal?.status === "open" &&
        proposal.revision !== linkedProposal(work).revision
      ) {
        throw new CliError(
          "The Suggested Change changed on the server since your last pull.",
          "barndog pull",
        );
      }

      const files = await readWorkingCopy(work, runtime);
      if (packageMetadataFor(files, work.kind).name !== work.name) {
        throw new CliError(
          `This working copy's name must stay ${work.name}. Change it back, then push again.`,
        );
      }

      const previous =
        proposal?.status === "open" && !options.new
          ? linkedProposal(work).files
          : work.base;

      if (
        packageFingerprint(files) ===
          packageFingerprint(decodeFiles(previous)) &&
        (!proposal || proposal.baseVersionId === work.baseVersionId) &&
        (!options.title || options.title === proposal?.title)
      ) {
        if (options.publish && proposal?.status === "open") {
          const merged = await api.merge(proposal.id, {
            expectedRevision: proposal.revision,
          });

          work.baseVersionId = publishedVersion(merged).id;
          work.baseNumber = publishedVersion(merged).number;
          work.base = linkedProposal(work).files;
          await save(work, runtime);

          return merged;
        }

        return { unchanged: true, proposalId: proposal?.id };
      }

      const changeId =
        proposal?.status === "open" && !options.new ? proposal.id : undefined;

      const metadata: PackageUpload = {
        assetId: work.assetId,
        name: work.name,
        origin: work.origin,
        baseVersionId: work.baseVersionId,
        expectedRevision: changeId ? linkedProposal(work).revision : undefined,
        title: options.title ?? proposal?.title ?? `Update ${work.name}`,
        idempotencyKey: randomUUID(),
      };

      work.pending = { metadata, files: encodeFiles(files), changeId };
      await save(work, runtime);
    }

    const pending = work.pending;
    const upload = await archive(pending.files, runtime);
    try {
      proposal = pending.changeId
        ? await api.revise(pending.changeId, pending.metadata, upload)
        : await api.submit(pending.metadata, upload);
    } catch (error) {
      // A definitive rejection did not accept this submission. Keep local edits and
      // permit pull/reconciliation; ambiguous transport failures retain the exact key.
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
        delete work.pending;
        await save(work, runtime);
      }

      throw error;
    }

    work.assetId = changeAssetId(proposal);
    work.proposal = {
      id: proposal.id,
      revision: proposal.submittedRevision,
      files: pending.files,
    };

    delete work.pending;
    await save(work, runtime);
    if (options.publish) {
      proposal = await api.merge(proposal.id, {
        expectedRevision: work.proposal.revision,
      });

      work.baseVersionId = publishedVersion(proposal).id;
      work.baseNumber = publishedVersion(proposal).number;
      work.base = work.proposal.files;
      await save(work, runtime);
    }

    return proposal;
  });
}

/**
 * Starts a Cloud working copy from the kind's scaffold. Contacts the server to
 * validate the connection and origin; asset content is uploaded only on `push`.
 */
export async function createWorkspace(
  { name, origin, kind }: { name: string; origin: string; kind: PackageKind },
  { target, runtime }: WorkingFolderOptions,
): Promise<CreatedPackage> {
  const { cwd } = runtime;

  return locked(runtime, async () => {
    if (!NAME.test(name)) {
      throw new CliError(
        `${name} isn't a valid name. Use lowercase letters, digits and hyphens, such as my-skill.`,
      );
    }

    const conn = await connection(runtime);
    const scope = await selectOrigin(origin, conn, runtime);

    const path = resolve(cwd, target ?? name);
    await mkdir(dirname(path), { recursive: true });
    await mkdir(path);
    const root = await realpath(path);
    const entries = assetKinds[kind].scaffold(name);
    try {
      await writePackage(root, entries, runtime);
      await save(
        {
          root,
          kind,
          connection: conn,
          name,
          origin: { type: scope.type, id: scope.id },
          baseVersionId: null,
          baseNumber: null,
          base: [],
          conflicts: [],
        },
        runtime,
      );

      return { root, kind, name };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  });
}
