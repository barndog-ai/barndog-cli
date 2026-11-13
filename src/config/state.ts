import { readFile, readlink } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import {
  isHarness,
  skillDirectory,
  type Harness,
} from "../harnesses/registry.js";
import { treeFingerprint } from "../features/environment/installed.js";
import { isRecord } from "../shared/values.js";
import { NAME, UUID_V4 } from "../shared/patterns.js";

export type Link = {
  id: string;
  harness: Harness;
  source: string;
  target: string;
};

export type State = { version: 1; links: Link[] };

/**
 * Older versions could record two assets at one target. Only one can be real, so
 * keep the link the target actually points to, then the one whose copy is on disk.
 */
async function withoutRepeatedLinks(links: unknown[], installed: unknown) {
  const records = Array.isArray(installed) ? installed.filter(isRecord) : [];
  const score = async (link: Record<string, unknown>) => {
    if (typeof link.target !== "string" || typeof link.source !== "string")
      return 0;
    const actual = await readlink(link.target).catch(() => null);
    const entry = records.find(
      (item) => item.id === link.id && item.path === link.source,
    );
    return (
      (actual === link.source ? 2 : 0) +
      (entry?.fingerprint === (await treeFingerprint(link.source)) ? 1 : 0)
    );
  };
  const kept: unknown[] = [];
  for (const link of links) {
    const index =
      isRecord(link) && typeof link.target === "string"
        ? kept.findIndex(
            (other) => isRecord(other) && other.target === link.target,
          )
        : -1;
    const held = kept[index];
    if (!isRecord(link) || !isRecord(held)) {
      kept.push(link);
      continue;
    }
    if ((await score(link)) > (await score(held))) kept[index] = link;
  }
  return kept;
}

export async function readState(path: string, home: string): Promise<State> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT")
      return { version: 1, links: [] };
    throw error;
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.links))
    throw new Error("Invalid installation state");
  const links = await withoutRepeatedLinks(value.links, value.installed);
  const targets = new Set<string>();
  const checked: Link[] = [];
  for (const link of links) {
    if (
      !isRecord(link) ||
      typeof link.id !== "string" ||
      !UUID_V4.test(link.id) ||
      !isHarness(link.harness) ||
      typeof link.source !== "string" ||
      !isAbsolute(link.source) ||
      typeof link.target !== "string" ||
      dirname(link.target) !== skillDirectory(link.harness, home) ||
      !NAME.test(basename(link.target)) ||
      targets.has(link.target)
    ) {
      throw new Error(
        "Invalid installation state; refusing to modify harness files",
      );
    }
    targets.add(link.target);
    checked.push({
      ...link,
      id: link.id,
      harness: link.harness,
      source: link.source,
      target: link.target,
    });
  }
  return { ...value, version: 1, links: checked };
}
