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
import {
  collaborationClient,
  metadata as packageMetadataFor,
} from "./domain.js";
import { assetKinds, type PackageKind } from "../asset-kinds/index.js";
import {
  connection,
  download,
  getChange,
  selectSkill,
  selectOrigin,
} from "./remote.js";

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
} from "./workspace-store.js";
import {
  externalSource,
  pullExternal,
  pushExternal,
} from "./workspace-github.js";

import { NoWorkingCopyError } from "./workspace-store.js";

export {
  NoWorkingCopyError,
  encodeFiles,
  decodeFiles,
} from "./workspace-store.js";

export async function pullSkill(
  name: string,
  origin: string,
  target?: string,
  cwd = process.cwd(),
  home = homedir(),
  kind: PackageKind = "skill",
) {
  return locked(home, async () => {
    const conn = await connection(home),
      skill = await selectSkill(name, origin, conn, home, kind);
    const path = resolve(cwd, target ?? name);
    await mkdir(dirname(path), { recursive: true });
    // Never overwrite an existing directory, even if it appears empty.
    await mkdir(path);
    const root = await realpath(path);
    try {
      const files = await download(
        `/v1/skills/${skill.id}/versions/${skill.version.number}/package`,
        conn,
        home,
        skill.version.commit,
        kind,
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

export async function workspaceStatus(cwd = process.cwd(), home = homedir()) {
  return locked(home, async () => {
    const work = await find(cwd, home),
      local = await readDirectory(work.root);
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

export async function updateWorkspace(cwd = process.cwd(), home = homedir()) {
  return locked(home, async () => {
    const work = await find(cwd, home);
    const previous = structuredClone(work);
    await connection(home, work.connection);
    if (work.pending || work.external?.pending)
      throw new Error(
        "Retry barndog push before pulling; a submission is awaiting confirmation",
      );
    if (work.conflicts.length)
      throw new Error("Resolve existing conflicts before pulling again");
    let entries = await readDirectory(work.root);
    const conflicts = new Set<string>();
    const source = await externalSource(work, home);
    if (source) return pullExternal(work, source, entries, previous, home);

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
          home,
          proposal.commit,
          work.kind,
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
            const versions = (
              await collaborationClient(
                work.connection.server,
                home,
                work.kind,
              ).GET("/v1/skills/{id}/versions", {
                params: { path: { id: work.skillId! } },
              })
            ).data!;
            const version = versions.find(
              (v) => v.id === proposal.baseVersionId,
            );
            if (!version)
              throw new Error("Proposal base version is unavailable");
            work.base = encodeFiles(
              await download(
                `/v1/skills/${work.skillId}/versions/${version.number}/package`,
                work.connection,
                home,
                version.commit,
                work.kind,
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
            params: { path: { id: work.skillId! } },
          })
        ).data,
      );
      if (skill.version.id !== work.baseVersionId) {
        const latest = await download(
          `/v1/skills/${skill.id}/versions/${skill.version.number}/package`,
          work.connection,
          home,
          skill.version.commit,
          work.kind,
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

export async function resolveConflict(
  path: string,
  cwd = process.cwd(),
  home = homedir(),
) {
  return locked(home, async () => {
    const work = await find(cwd, home);
    return markResolved(work, path, cwd, home);
  });
}

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
  if (!conflict) throw new Error("Path is not an unresolved conflict");
  const files = await readDirectory(work.root),
    file = files.find((e) => e.path === conflict);
  if (
    file &&
    /^(<{7}|\|{7}|={7}|>{7})(?: |$)/m.test(textContent(file.data) ?? "")
  )
    throw new Error("Remove conflict markers before resolving this file");
  const paths = new Set(files.map((e) => e.path));
  for (const p of paths)
    if ([...paths].some((other) => p.startsWith(other + "/")))
      throw new Error("File/directory collision remains");
  work.conflicts = work.conflicts.filter((p) => p !== conflict);
  await save(work, home);
  return { resolved: conflict, remaining: work.conflicts };
}

export async function archive(files: Files, home: string) {
  const temp = join(directory(home), `upload-${randomUUID()}`),
    tar = temp + ".tar.gz";
  try {
    await writePackage(temp, decodeFiles(files));
    await c(
      { cwd: temp, file: tar, gzip: true, portable: true, noMtime: true },
      files.map((e) => e.path),
    );
    const bytes = await readFile(tar);
    if (bytes.length > defaultLimits.compressed)
      throw new Error("PACKAGE_TOO_LARGE");
    return new Blob([bytes]);
  } finally {
    await rm(temp, { recursive: true, force: true });
    await rm(tar, { force: true });
  }
}

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
) {
  return locked(home, async () => {
    let work: Workspace;
    try {
      work = await find(cwd, home);
    } catch (error) {
      if (!options.origin || !(error instanceof NoWorkingCopyError))
        throw error;
      const conn = await connection(home),
        root = await realpath(cwd),
        description = packageMetadataFor(
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
    if (options.kind && work.kind !== options.kind)
      throw new Error("Working copy belongs to a different asset kind");
    if (options.name && work.name !== options.name)
      throw new Error("Working-copy name does not match the requested asset");
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
        if (work.skillId || work.proposal || work.pending)
          throw new Error("A submitted working copy cannot change its origin");
        work.origin = { type: selected.type, id: selected.id };
        await save(work, home);
      }
    }
    if (work.conflicts.length)
      throw new Error(
        "Resolve conflicts with barndog resolve <path> before pushing",
      );
    const source = await externalSource(work, home);
    if (source) return pushExternal(work, source, options, home);
    const client = collaborationClient(work.connection.server, home, work.kind);
    if (options.publish) {
      const scope = await selectOrigin(
        `${work.origin.type}:${work.origin.id}`,
        work.connection,
        home,
      );
      if (!scope.canPublish)
        throw new Error(
          "Direct publication requires a scope admin, organization admin, or personal owner; use barndog changes merge after review",
        );
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
        packageFingerprint(decodeFiles(work.proposal!.files))
    ) {
      work.baseVersionId = proposal.publishedVersion.id;
      work.baseNumber = proposal.publishedVersion.number;
      work.base = work.proposal!.files;
      await save(work, home);
      return proposal;
    }
    if (!work.pending) {
      if (proposal?.status === "rejected" && !options.new)
        throw new Error(
          "Suggested Change was rejected; use barndog push --new for a new proposal",
        );
      if (
        proposal?.status === "merged" &&
        proposal.publishedVersion?.id !== work.baseVersionId
      )
        throw new Error(
          "Run barndog pull before starting another Suggested Change",
        );
      if (
        proposal?.status === "open" &&
        proposal.revision !== work.proposal!.revision
      )
        throw new Error(
          "Suggested Change changed remotely; run barndog pull before pushing",
        );
      const files = await readDirectory(work.root);
      if (packageMetadataFor(files, work.kind).name !== work.name)
        throw new Error("Package name cannot change in this working copy");
      const previous =
        proposal?.status === "open" && !options.new
          ? work.proposal!.files
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
          work.baseVersionId = merged.publishedVersion!.id;
          work.baseNumber = merged.publishedVersion!.number;
          work.base = work.proposal!.files;
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
        expectedRevision: changeId ? work.proposal!.revision : undefined,
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
        [400, 403, 404, 409, 413].includes(error.status)
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
      work.baseVersionId = proposal.publishedVersion!.id;
      work.baseNumber = proposal.publishedVersion!.number;
      work.base = work.proposal.files;
      await save(work, home);
    }
    return proposal;
  });
}

export async function createWorkspace(
  name: string,
  origin: string,
  target?: string,
  cwd = process.cwd(),
  home = homedir(),
  kind: PackageKind = "skill",
) {
  return locked(home, async () => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
      throw new Error("Use a lowercase hyphenated package name");
    const conn = await connection(home),
      scope = await selectOrigin(origin, conn, home);
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
