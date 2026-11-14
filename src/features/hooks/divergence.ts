import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  divergentHookTools,
  hookManifestSchema,
  type HookManifest,
} from "@barndog-ai/api-contract";
import { parse } from "yaml";

import { adapters, harnesses } from "../../harnesses/registry.js";

/**
 * A caution for Hooks whose coding tools run different scripts: changing one
 * tool's scripts leaves the others as they were. Null when all share one set.
 */
function divergenceWarning(implementations: HookManifest["implementations"]) {
  const divergent = divergentHookTools(implementations);
  if (!divergent.length) {
    return null;
  }

  const names = harnesses
    .filter((harness) => divergent.includes(harness))
    .map((harness) => adapters[harness].name);

  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} run different scripts in this Hook. When you change it for one, check whether the others need the same change.`;
}

/** The same caution for a Hook folder on disk; null when it has no readable hook.yaml. */
export async function folderDivergence(folder: string) {
  try {
    const manifest = hookManifestSchema.parse(
      parse(await readFile(join(folder, "hook.yaml"), "utf8")),
    );

    return divergenceWarning(manifest.implementations);
  } catch {
    return null;
  }
}

/** The Hook working copy a folder sits in, however deep; null outside one. */
export function nearestHookFolder(from: string) {
  for (let folder = from; ; folder = dirname(folder)) {
    if (existsSync(join(folder, "hook.yaml"))) {
      return folder;
    }

    if (folder === dirname(folder)) {
      return null;
    }
  }
}
