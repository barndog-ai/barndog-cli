import { POSIX_MODE } from "../../shared/constants.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  defaultLimits,
  parsePackage,
  packageFingerprint,
  directoryFingerprint,
  writePackage,
  type PackageEntry,
} from "@barndog-ai/api-contract/package";
import type { Connection } from "../../config/settings.js";
import { serverFetch } from "../auth/transport.js";
import { assetKinds, metadata } from "../asset-kinds/index.js";
import { type PackageKind } from "../../config/selection.js";
import { GIT_OBJECT_ID } from "../../shared/patterns.js";
import { CliError, PackageError } from "../../errors.js";
import { barndogPaths, packageManifest } from "../../config/paths.js";
import { ifExists, writeAtomic } from "../../shared/files.js";

/** One identity's cache partition: server, organization and developer never mix. */
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
  home: string,
  keep: ReadonlySet<string>,
) {
  const root = barndogPaths(home).packageCache(key);
  let removed = 0;
  const children = async (path: string) =>
    (await ifExists(readdir(path))) ?? [];

  for (const parent of [root, join(root, "hooks")]) {
    for (const asset of await children(parent)) {
      if (!/^[0-9a-f-]{36}$/i.test(asset)) {
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
  { key, home }: { key: string; home: string },
  load: () => Promise<PackageEntry[]>,
) {
  const parent = join(
    barndogPaths(home).packageCache(key),
    ...assetKinds[kind].cachePath,
    asset.id,
  );

  await mkdir(parent, { recursive: true, mode: POSIX_MODE.privateDirectory });
  const check = async (root: string) => {
    const saved = z
      .object({ fingerprint: z.string() })
      .safeParse(JSON.parse(await readFile(packageManifest(root), "utf8")));

    if (
      !saved.success ||
      (await directoryFingerprint(join(root, asset.name))) !==
        saved.data.fingerprint
    ) {
      throw new CliError(
        `The downloaded copy of ${asset.name} in ${root} was changed on this machine, so BarnDog won't use it.`,
        `rm -r ${root} && barndog sync`,
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
    await writePackage(join(stage, asset.name), entries);
    await writeAtomic(
      packageManifest(stage),
      JSON.stringify({ fingerprint: packageFingerprint(entries) }),
    );

    await rename(stage, target);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }

  return join(target, asset.name);
}

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
  home: string,
) {
  return storePackage(
    kind,
    { id: asset.id, name: asset.name, revision: asset.version.commit },
    { key: cacheKey(conn), home },
    async () => {
      const response = await serverFetch(
        conn.server,
        home,
      )(
        `${conn.server}/v1/${assetKinds[kind].route}/${asset.id}/versions/${asset.version.number}/package`,
      );

      if (!response.ok) {
        throw new CliError(
          `Downloading ${asset.name} failed (${response.status}). Try again.`,
          "barndog sync",
        );
      }

      if (response.headers.get("etag") !== `"${asset.version.commit}"`) {
        throw new CliError(
          `${asset.name} changed on the server while it was downloading. Try again.`,
          "barndog sync",
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

      const entries = await parsePackage(
        Buffer.concat(chunks),
        defaultLimits,
        assetKinds[kind].manifest,
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
