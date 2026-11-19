import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  hookManifestSchema,
  type HookManifest,
} from "@barndog-ai/api-contract";
import { parse } from "yaml";

import { hookHarnesses } from "../../harnesses/registry.js";
import type { HookHarness } from "../../harnesses/types.js";
import { toolNames } from "./adapt.js";

/**
 * Tools grouped by the script files they run, largest group first. A tool
 * whose commands run no script file of the Hook's has nothing to keep in step,
 * so it's left out.
 */
function scriptGroups(implementations: HookManifest["implementations"]) {
  const groups = new Map<string, HookHarness[]>();
  for (const harness of hookHarnesses) {
    const scripts = [...new Set(implementations[harness]?.scripts)].sort();
    if (scripts.length) {
      const key = scripts.join("\0");
      groups.set(key, [...(groups.get(key) ?? []), harness]);
    }
  }

  return [...groups.values()].sort((a, b) => b.length - a.length);
}

const inToolOrder = (tools: HookHarness[]) =>
  hookHarnesses.filter((harness) => tools.includes(harness));

/**
 * A caution for Hooks whose coding tools run different scripts: changing one
 * tool's scripts leaves the others as they were. Null when they all share one
 * set, or when at most one tool runs scripts at all.
 */
function divergenceWarning(implementations: HookManifest["implementations"]) {
  const [shared, ...rest] = scriptGroups(implementations);
  if (!shared || !rest.length) {
    return null;
  }

  if (shared.length === 1) {
    const tools = inToolOrder([shared, ...rest].flat());

    return `${toolNames(tools)} each run their own scripts in this Hook. When you change one, check whether the ${tools.length === 2 ? "other needs" : "others need"} the same change.`;
  }

  const odd = inToolOrder(rest.flat());

  return `${toolNames(odd)} ${odd.length === 1 ? "runs" : "run"} different scripts from ${toolNames(shared)} in this Hook. When you change one set, check whether the other needs the same change.`;
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
