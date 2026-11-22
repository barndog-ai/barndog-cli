/**
 * Whether a newer BarnDog CLI is published. The answer comes from the public
 * npm registry, whichever workspace or server the developer uses, and is
 * cached in `~/.barndog/update-check.json`, so a command only reads a file;
 * a detached process (`entry/update-check.ts`) refreshes it at most once a day.
 */
import { stat } from "node:fs/promises";

import semver from "semver";
import { z } from "zod";

import { barndogPaths } from "../../config/paths.js";
import type { RuntimeContext } from "../../runtime.js";
import {
  HOURS_PER_DAY,
  MILLISECONDS_PER_MINUTE,
  MINUTES_PER_HOUR,
} from "../../shared/constants.js";
import { ifExists, readJsonIfExists, writeAtomic } from "../../shared/files.js";

/** The package's dist-tags, from the npm registry API. */
const DIST_TAGS_URL = "https://registry.npmjs.org/-/package/barndog/dist-tags";

/** Once a day is often enough to hear about a release. */
const CHECK_INTERVAL_MS =
  HOURS_PER_DAY * MINUTES_PER_HOUR * MILLISECONDS_PER_MINUTE;

/** The background check gives up rather than linger. */
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Variables that turn the check off. `NO_UPDATE_NOTIFIER` is the one the
 * `update-notifier` package made common across npm CLIs.
 */
const OPT_OUT_VARIABLES = ["BARNDOG_NO_UPDATE_CHECK", "NO_UPDATE_NOTIFIER"];

const distTagsSchema = z.object({
  latest: z.string(),
  next: z.string().optional(),
});

const cacheSchema = z.object({
  checkedAt: z.string(),
  /** Absent until the registry has answered once. */
  latest: z.string().optional(),
  next: z.string().optional(),
});

type UpdateCache = z.infer<typeof cacheSchema>;

/** A published version newer than the one running, and the dist-tag to install. */
export type AvailableUpdate = {
  current: string;
  version: string;
  /** `next` only for someone already on a prerelease. */
  tag: "latest" | "next";
};

/** What a command does about updates once it has finished. */
export type UpdateCheck = {
  /** A newer version to tell the developer about. */
  update?: AvailableUpdate;
  /** Whether the cached answer is old enough to ask the registry again. */
  due: boolean;
};

/** A missing or unreadable cache counts as never checked. */
async function readCache(home: string): Promise<UpdateCache | undefined> {
  try {
    return (
      (await readJsonIfExists(barndogPaths(home).updateCheck, cacheSchema)) ??
      undefined
    );
  } catch {
    return undefined;
  }
}

/**
 * Asks the registry for the published versions and caches them. A failure is
 * cached as a check that keeps the earlier answer, so an offline machine
 * still waits a day before trying again.
 */
export async function refreshUpdateCheck(
  runtime: RuntimeContext,
  fetchTags: typeof fetch = fetch,
): Promise<void> {
  const previous = await readCache(runtime.home);

  let tags: z.infer<typeof distTagsSchema> | undefined;
  try {
    const response = await fetchTags(DIST_TAGS_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    tags = response.ok
      ? distTagsSchema.parse(await response.json())
      : undefined;
  } catch {
    tags = undefined;
  }

  const cache: UpdateCache = {
    checkedAt: new Date().toISOString(),
    latest: tags ? tags.latest : previous?.latest,
    next: tags ? tags.next : previous?.next,
  };

  await writeAtomic(
    barndogPaths(runtime.home).updateCheck,
    `${JSON.stringify(cache)}\n`,
  );
}

/**
 * The newest cached version above `current`. Someone on a prerelease also
 * hears about newer prereleases; everyone else only about `latest`.
 */
function newestAbove(
  current: string,
  cache: UpdateCache,
): AvailableUpdate | undefined {
  if (!semver.valid(current)) {
    return undefined;
  }

  const candidates: AvailableUpdate[] = [];
  if (cache.latest && semver.valid(cache.latest)) {
    candidates.push({ current, version: cache.latest, tag: "latest" });
  }

  if (cache.next && semver.valid(cache.next) && semver.prerelease(current)) {
    candidates.push({ current, version: cache.next, tag: "next" });
  }

  return candidates
    .filter((candidate) => semver.gt(candidate.version, current))
    .sort((a, b) => semver.rcompare(a.version, b.version))[0];
}

/**
 * What to do about updates after a command, from the cache alone. Undefined
 * when the check is off: by an opt-out variable, in CI, or while BarnDog isn't
 * set up (before `init`, after `uninstall`), so it never creates `~/.barndog/`.
 */
export async function updateCheck(
  current: string,
  runtime: RuntimeContext,
): Promise<UpdateCheck | undefined> {
  const { env, home } = runtime;
  if (env.CI || OPT_OUT_VARIABLES.some((name) => env[name]?.trim())) {
    return undefined;
  }

  if (!(await ifExists(stat(barndogPaths(home).settings)))) {
    return undefined;
  }

  const cache = await readCache(home);

  return {
    update: cache && newestAbove(current, cache),
    due:
      !cache || !(Date.now() - Date.parse(cache.checkedAt) < CHECK_INTERVAL_MS),
  };
}
