import { directoryFingerprint, writePackage } from "./directory.js";
import { fixSteps, removeCommand } from "../../platform.js";
import type { RuntimeContext } from "../../runtime.js";
import { POSIX_MODE } from "../../shared/constants.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  defaultLimits,
  parsePackage,
  type PackageEntry,
} from "@barndog-ai/api-contract/package";
import type { Connection } from "../../config/settings.js";
import { ApiError } from "@barndog-ai/api-contract";
import { type ApiClient, apiClient } from "../auth/transport.js";
import { assetKinds, metadata } from "../asset-kinds/index.js";
import {
  assetFolders,
  packageKindList,
  type PackageKind,
} from "../../config/selection.js";
import { GIT_OBJECT_ID, UUID_V4 } from "../../shared/patterns.js";
import { CliError, PackageError } from "../../errors.js";
import { barndogPaths, packageManifest } from "../../config/paths.js";
import { ifExists, readIfExists, writeAtomic } from "../../shared/files.js";

/** One identity's cache partition: server, organization and developer never mix. */

/** `text` parsed as JSON, or undefined when it is missing or not JSON. */
function jsonOrUndefined(text: string | null): unknown {
  if (text === null) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function cacheKey(conn: Connection) {
  const server = createHash("sha256").update(conn.server).digest("hex");

  return join(server, conn.organizationId, conn.developerId);
}

/**
 * Deletes cached versions nothing installs any more. Every cached version was
 * downloaded from the workspace, so an older one can always be fetched again.
 * Other identities' caches are left alone.
 */
export async function pruneCache(
  key: string,
  runtime: RuntimeContext,
  keep: ReadonlySet<string>,
) {
  const { home } = runtime;

  const root = barndogPaths(home).packageCache(key);
  let removed = 0;
  const children = async (path: string) =>
    (await ifExists(readdir(path))) ?? [];

  for (const parent of packageKindList.map((kind) =>
    join(root, assetFolders[kind]),
  )) {
    for (const asset of await children(parent)) {
      if (!UUID_V4.test(asset)) {
        continue;
      }

      const directory = join(parent, asset);
      for (const revision of await children(directory)) {
        const path = join(directory, revision);
        if (keep.has(path)) {
          continue;
        }

        if (!GIT_OBJECT_ID.test(revision) && !revision.startsWith(".stage-")) {
          continue;
        }

        await rm(path, { recursive: true, force: true });
        removed++;
      }

      if (!(await children(directory)).length) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }

  return removed;
}

type CachedAsset = { id: string; name: string; revision: string };

/** Returns the immutable cached folder for a revision, loading it only when absent. */
export async function storePackage(
  kind: PackageKind,
  asset: CachedAsset,
  { key, runtime }: { key: string; runtime: RuntimeContext },
  load: () => Promise<PackageEntry[]>,
) {
  const { home } = runtime;
  const parent = join(
    barndogPaths(home).packageCache(key),
    assetFolders[kind],
    asset.id,
  );

  await mkdir(parent, { recursive: true, mode: POSIX_MODE.privateDirectory });
  const check = async (root: string) => {
    // A missing or unreadable manifest means the same as a wrong fingerprint.
    const saved = z
      .object({ fingerprint: z.string() })
      .safeParse(jsonOrUndefined(await readIfExists(packageManifest(root))));

    if (
      !saved.success ||
      (await directoryFingerprint(join(root, asset.name), runtime)) !==
        saved.data.fingerprint
    ) {
      throw new CliError(
        `The downloaded copy of ${asset.name} in ${root} was changed on this machine, so BarnDog won't use it.`,
        "Delete that folder; the next sync downloads it again.",
        {
          command: fixSteps(
            [removeCommand(root, runtime.platform), "barndog sync"],
            runtime.platform,
          ),
        },
      );
    }
  };

  for (const revision of await readdir(parent)) {
    if (GIT_OBJECT_ID.test(revision)) {
      await check(join(parent, revision));
    }
  }

  const target = join(parent, asset.revision);
  if (await ifExists(lstat(target))) {
    await check(target);

    return join(target, asset.name);
  }

  const entries = await load();
  const stage = join(parent, `.stage-${randomUUID()}`);
  try {
    await writePackage(join(stage, asset.name), entries, runtime);
    // Read back, so Windows (no executable bits) records what `check` will see.
    await writeAtomic(
      packageManifest(stage),
      JSON.stringify({
        fingerprint: await directoryFingerprint(
          join(stage, asset.name),
          runtime,
        ),
      }),
    );

    await rename(stage, target);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }

  return join(target, asset.name);
}

/** A typed-client call made with `parseAs: "stream"`, so the body is still unread. */
export type PackageDownload = Promise<{ response: Response }>;

/**
 * Reads and unpacks a package download within the package size limits. With
 * `commit`, refuses a package whose ETag names another revision. `subject`
 * names the package in errors.
 */
export async function unpackDownload(
  download: PackageDownload,
  options: {
    kind: PackageKind;
    commit?: string;
    subject: string;
    fix?: string;
  },
): Promise<PackageEntry[]> {
  const { kind, commit, subject, fix } = options;
  let response: Response;
  try {
    ({ response } = await download);
  } catch (error) {
    if (error instanceof ApiError) {
      throw new CliError(
        `Downloading ${subject} failed (${error.status}). Try again.`,
        fix,
        { cause: error },
      );
    }

    throw error;
  }

  if (commit && response.headers.get("etag") !== `"${commit}"`) {
    throw new CliError(
      `The server changed ${subject} while it was downloading. Try again.`,
      fix,
    );
  }

  if (!response.body) {
    throw new Error("The server sent a package download with no body");
  }

  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > defaultLimits.compressed) {
      throw new PackageError("PACKAGE_TOO_LARGE");
    }

    chunks.push(chunk);
  }

  return parsePackage(
    Buffer.concat(chunks),
    defaultLimits,
    assetKinds[kind].manifest,
  );
}

type PublishedVersion = { id: string; version: { number: number } };

/** The published-package route of each kind. */
const packageDownloads: Record<
  PackageKind,
  (client: ApiClient, asset: PublishedVersion) => PackageDownload
> = {
  skill: (client, asset) =>
    client.GET("/v1/skills/{id}/versions/{version}/package", {
      params: { path: { id: asset.id, version: asset.version.number } },
      parseAs: "stream",
    }),
  hook: (client, asset) =>
    client.GET("/v1/hooks/{id}/versions/{version}/package", {
      params: { path: { id: asset.id, version: asset.version.number } },
      parseAs: "stream",
    }),
};

/**
 * Returns a cached package or downloads and validates its revision, size and
 * metadata before storing it.
 */
export async function cachedPackage(
  kind: PackageKind,
  asset: {
    id: string;
    name: string;
    version: { commit: string; number: number };
  },
  conn: Connection,
  runtime: RuntimeContext,
) {
  return storePackage(
    kind,
    { id: asset.id, name: asset.name, revision: asset.version.commit },
    { key: cacheKey(conn), runtime },
    async () => {
      const entries = await unpackDownload(
        packageDownloads[kind](apiClient(conn.server, runtime), asset),
        {
          kind,
          commit: asset.version.commit,
          subject: asset.name,
          fix: "barndog sync",
        },
      );

      if (metadata(entries, kind).name !== asset.name) {
        throw new Error(
          `The server sent a package whose name isn't ${asset.name}`,
        );
      }

      return entries;
    },
  );
}
