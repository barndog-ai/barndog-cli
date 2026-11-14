import { HTTP_STATUS } from "../../shared/constants.js";

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";

import { c } from "tar";
import {
  ApiError,
  changeSchema,
  skillSchema,
  type ChangeUpload,
} from "@barndog-ai/api-contract";
import {
  defaultLimits,
  packageFingerprint,
  writePackage,
} from "@barndog-ai/api-contract/package";
import {
  diffEntries,
  mergeEntries,
  readDirectory,
  textContent,
} from "@barndog-ai/api-contract/collaboration";
import { collaborationClient, responseData } from "./domain.js";
import {
  metadata as packageMetadataFor,
  assetKinds,
} from "../asset-kinds/index.js";
import { type PackageKind } from "../../config/selection.js";
import { download, getChange, selectSkill } from "./remote.js";
import { selectOrigin } from "../server/origin.js";
import { connection } from "../server/connection.js";

import {
  encodeFiles,
  decodeFiles,
  directory,
  save,
  locked,
  find,
  applyFiles,
  type Workspace,
  type Files,
  NoWorkingCopyError,
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

const publishedId = (work: { skillId?: string | null }) =>
  defined(work.skillId, "This working copy isn't published yet");

const linkedProposal = <P>(work: { proposal?: P | null }) =>
  defined(work.proposal, "This working copy has no linked proposal");

const publishedVersion = <V>(change: { publishedVersion?: V | null }) =>
  defined(
    change.publishedVersion,
    "The merged change has no published version",
  );

export { NoWorkingCopyError } from "./workspace-store.js";

/** Where a new working folder goes. */
export type WorkingFolderOptions = {
  /** The new folder; defaults to `./<name>`. */
  target?: string;
  cwd?: string;
  home?: string;
};

/**
 * `pull <name>` in Cloud: downloads the published Skill or Hook into a new
 * working folder (`target`, default `./<name>`) and registers it under
 * `~/.barndog/workspaces/`. Refuses a folder that already exists.
 */
export async function pullSkill(
  {
    name,
    origin,
    kind = "skill",
  }: { name: string; origin: string; kind?: PackageKind },
  { target, cwd = process.cwd(), home = homedir() }: WorkingFolderOptions = {},
): Promise<PulledPackage> {
  return locked(home, async () => {
    const conn = await connection(home);
    const skill = await selectSkill(
      { name, selector: origin, kind },
      conn,
      home,
    );

    const path = resolve(cwd, target ?? name);
    await mkdir(dirname(path), { recursive: true });
    // Never overwrite an existing directory, even if it appears empty.
    await mkdir(path);
    const root = await realpath(path);
    try {
      const files = await download(
        `/v1/skills/${skill.id}/versions/${skill.version.number}/package`,
        conn,
        { home, commit: skill.version.commit, kind },
      );

      await writePackage(root, files);
      await save(
        {
          root,
          kind,
          connection: conn,
          skillId: skill.id,
          name: skill.name,
          origin: { type: skill.origin.type, id: skill.origin.id },
          baseVersionId: skill.version.id,
          baseNumber: skill.version.number,
          base: encodeFiles(files),
          conflicts: [],
        },
        home,
      );

      return { root, version: skill.version.number };
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
  cwd = process.cwd(),
  home = homedir(),
): Promise<CloudWorkingCopyStatus> {
  return locked(home, async () => {
    const work = await find(cwd, home);
    const local = await readDirectory(work.root);

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
  cwd = process.cwd(),
  home = homedir(),
): Promise<UpdatedCloudWorkingCopy> {
  return locked(home, async () => {
    const work = await find(cwd, home);
    const previous = structuredClone(work);
    await connection(home, work.connection);
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

    let entries = await readDirectory(work.root);
    const conflicts = new Set<string>();
    const source = await externalSource(work, home);
    if (source) {
      return pullExternal(work, { source, entries, previous }, home);
    }

    if (work.proposal) {
      const proposal = await getChange(
        work.proposal.id,
        work.connection,
        home,
        work.kind,
      );

      if (proposal.revision !== work.proposal.revision) {
        const remote = await download(
          `/v1/skill-changes/${proposal.id}/package?revision=${proposal.revision}`,
          work.connection,
          { home, commit: proposal.commit, kind: work.kind },
        );

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
            const versions = responseData(
              await collaborationClient(
                work.connection.server,
                home,
                work.kind,
              ).GET("/v1/skills/{id}/versions", {
                params: { path: { id: publishedId(work) } },
              }),
            );

            const version = versions.find(
              (v) => v.id === proposal.baseVersionId,
            );

            if (!version) {
              throw new Error(
                "The server didn't return the version this Suggested Change is based on",
              );
            }

            work.base = encodeFiles(
              await download(
                `/v1/skills/${work.skillId}/versions/${version.number}/package`,
                work.connection,
                { home, commit: version.commit, kind: work.kind },
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
      const skill = skillSchema.parse(
        (
          await collaborationClient(
            work.connection.server,
            home,
            work.kind,
          ).GET("/v1/skills/{id}", {
            params: { path: { id: publishedId(work) } },
          })
        ).data,
      );

      if (skill.version.id !== work.baseVersionId) {
        const latest = await download(
          `/v1/skills/${skill.id}/versions/${skill.version.number}/package`,
          work.connection,
          { home, commit: skill.version.commit, kind: work.kind },
        );

        const merged = await mergeEntries(
          decodeFiles(work.base),
          entries,
          latest,
        );

        entries = merged.entries;
        merged.conflicts.forEach((p) => conflicts.add(p));
        work.base = encodeFiles(latest);
        work.baseVersionId = skill.version.id;
        work.baseNumber = skill.version.number;
      }
    } else if (work.proposal) {
      const proposal = await getChange(
        work.proposal.id,
        work.connection,
        home,
        work.kind,
      );

      if (proposal.publishedVersion) {
        work.baseVersionId = proposal.publishedVersion.id;
        work.baseNumber = proposal.publishedVersion.number;
        work.base = work.proposal.files;
      }
    }

    work.conflicts = [...conflicts];
    await applyFiles(work, entries, home, previous);

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
  cwd = process.cwd(),
  home = homedir(),
): Promise<ConflictResolution> {
  return locked(home, async () => {
    const work = await find(cwd, home);

    return markResolved(work, path, cwd, home);
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
export async function markResolved(
  work: Pick<
    Workspace,
    "root" | "conflicts" | "pendingWrite" | "pendingSnapshot"
  >,
  path: string,
  cwd: string,
  home: string,
) {
  const absolute = resolve(await realpath(cwd), path);
  const conflict = work.conflicts.find((p) => join(work.root, p) === absolute);
  if (!conflict) {
    throw new CliError(
      `${path} isn't an unresolved conflict.`,
      "barndog status",
    );
  }

  const files = await readDirectory(work.root);
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
  await save(work, home);

  return { resolved: conflict, remaining: work.conflicts };
}

/**
 * Packs base64-encoded files into the gzipped tarball the server's upload
 * routes take. Fails with `PACKAGE_TOO_LARGE` above the compressed size limit;
 * uses a temporary folder under `~/.barndog/workspaces/`.
 */
export async function archive(files: Files, home: string) {
  const temp = join(directory(home), `upload-${randomUUID()}`);
  const tar = temp + ".tar.gz";

  try {
    await writePackage(temp, decodeFiles(files));
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
  cwd = process.cwd(),
  home = homedir(),
): Promise<CloudPushResult> {
  return locked(home, async () => {
    let work: Workspace;
    try {
      work = await find(cwd, home);
    } catch (error) {
      if (!options.origin || !(error instanceof NoWorkingCopyError)) {
        throw error;
      }

      const conn = await connection(home);
      const root = await realpath(cwd);
      const description = packageMetadataFor(
        await readDirectory(root),
        options.kind ?? "skill",
      );

      const origin = await selectOrigin(options.origin, conn, home);
      work = {
        root,
        kind: options.kind ?? "skill",
        connection: conn,
        name: description.name,
        origin: { type: origin.type, id: origin.id },
        baseVersionId: null,
        baseNumber: null,
        base: [],
        conflicts: [],
      };

      await save(work, home);
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

    await connection(home, work.connection);
    if (options.origin) {
      const selected = await selectOrigin(
        options.origin,
        work.connection,
        home,
      );

      if (
        selected.type !== work.origin.type ||
        selected.id !== work.origin.id
      ) {
        if (work.skillId || work.proposal || work.pending) {
          throw new CliError(
            "This working copy was already submitted, so its origin can't change. Push without --origin.",
            "barndog push",
          );
        }

        work.origin = { type: selected.type, id: selected.id };
        await save(work, home);
      }
    }

    if (work.conflicts.length) {
      throw new CliError(
        "Resolve the conflicts before pushing.",
        "barndog resolve <path>",
      );
    }

    const source = await externalSource(work, home);
    if (source) {
      return pushExternal(work, source, options, home);
    }

    const client = collaborationClient(work.connection.server, home, work.kind);
    if (options.publish) {
      const scope = await selectOrigin(
        `${work.origin.type}:${work.origin.id}`,
        work.connection,
        home,
      );

      if (!scope.canPublish) {
        throw new CliError(
          "Only a scope admin, an organization admin or the personal owner can publish directly. Propose it for review instead, then merge it with barndog changes merge.",
          "barndog push",
        );
      }
    }

    let proposal = work.proposal
      ? await getChange(work.proposal.id, work.connection, home, work.kind)
      : undefined;

    if (
      !work.pending &&
      options.publish &&
      proposal?.status === "merged" &&
      proposal.publishedVersion &&
      packageFingerprint(await readDirectory(work.root)) ===
        packageFingerprint(decodeFiles(linkedProposal(work).files))
    ) {
      work.baseVersionId = proposal.publishedVersion.id;
      work.baseNumber = proposal.publishedVersion.number;
      work.base = linkedProposal(work).files;
      await save(work, home);

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

      const files = await readDirectory(work.root);
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
          const merged = changeSchema.parse(
            (
              await client.POST("/v1/skill-changes/{id}/merge", {
                params: { path: { id: proposal.id } },
                body: { expectedRevision: proposal.revision },
              })
            ).data,
          );

          work.baseVersionId = publishedVersion(merged).id;
          work.baseNumber = publishedVersion(merged).number;
          work.base = linkedProposal(work).files;
          await save(work, home);

          return merged;
        }

        return { unchanged: true, proposalId: proposal?.id };
      }

      const changeId =
        proposal?.status === "open" && !options.new ? proposal.id : undefined;

      const metadata: ChangeUpload = {
        skillId: work.skillId,
        name: work.name,
        origin: work.origin,
        baseVersionId: work.baseVersionId,
        expectedRevision: changeId ? linkedProposal(work).revision : undefined,
        title: options.title ?? proposal?.title ?? `Update ${work.name}`,
        idempotencyKey: randomUUID(),
      };

      work.pending = { metadata, files: encodeFiles(files), changeId };
      await save(work, home);
    }

    const pending = work.pending;
    const form = new FormData();
    form.set("metadata", JSON.stringify(pending.metadata));
    form.set("package", await archive(pending.files, home), "skill.tar.gz");
    try {
      proposal = changeSchema.parse(
        pending.changeId
          ? (
              await client.PUT("/v1/skill-changes/{id}/revisions", {
                params: { path: { id: pending.changeId } },
                body: form,
              })
            ).data
          : (await client.POST("/v1/skill-changes", { body: form })).data,
      );
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
        await save(work, home);
      }

      throw error;
    }

    work.skillId = proposal.skillId;
    work.proposal = {
      id: proposal.id,
      revision: proposal.submittedRevision,
      files: pending.files,
    };

    delete work.pending;
    await save(work, home);
    if (options.publish) {
      proposal = changeSchema.parse(
        (
          await client.POST("/v1/skill-changes/{id}/merge", {
            params: { path: { id: proposal.id } },
            body: { expectedRevision: work.proposal.revision },
          })
        ).data,
      );

      work.baseVersionId = publishedVersion(proposal).id;
      work.baseNumber = publishedVersion(proposal).number;
      work.base = work.proposal.files;
      await save(work, home);
    }

    return proposal;
  });
}

/**
 * Starts a Cloud working copy from the kind's scaffold. Contacts the server to
 * validate the connection and origin; asset content is uploaded only on `push`.
 */
export async function createWorkspace(
  {
    name,
    origin,
    kind = "skill",
  }: { name: string; origin: string; kind?: PackageKind },
  { target, cwd = process.cwd(), home = homedir() }: WorkingFolderOptions = {},
): Promise<CreatedPackage> {
  return locked(home, async () => {
    if (!NAME.test(name)) {
      throw new CliError(
        `${name} isn't a valid name. Use lowercase letters, digits and hyphens, such as my-skill.`,
      );
    }

    const conn = await connection(home);
    const scope = await selectOrigin(origin, conn, home);

    const path = resolve(cwd, target ?? name);
    await mkdir(dirname(path), { recursive: true });
    await mkdir(path);
    const root = await realpath(path);
    const entries = assetKinds[kind].scaffold(name);
    try {
      await writePackage(root, entries);
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
        home,
      );

      return { root, kind, name };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  });
}
