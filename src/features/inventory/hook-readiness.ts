import type { RuntimeContext } from "../../runtime.js";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { hookManifestSchema } from "@barndog-ai/api-contract";
import { readIfExists } from "../../shared/files.js";
import { isHookHarness } from "../../harnesses/registry.js";
import type { Harness } from "../../harnesses/types.js";
import { hookIssue } from "../native/adapters.js";
import type { HookSkip } from "../native/requirements.js";

/**
 * Why sync installs a selected Hook in none of the selected tools, read from
 * its materialized package: `no-version` when it has no implementation for any
 * of them, `cant-run` when it has one but this machine lacks what it needs.
 * Null when some tool can run it, or the package isn't there or can't be read.
 */
export async function hookBlocked(
  folder: string,
  harnesses: readonly Harness[],
  runtime: RuntimeContext,
): Promise<"no-version" | "cant-run" | null> {
  const text = await readIfExists(join(folder, "hook.yaml"));
  if (text === null) {
    return null;
  }

  // A hand-edited package is doctor's to report; here it only can't be judged.
  const document = parseDocument(text);
  const parsed = hookManifestSchema.safeParse(
    document.errors.length ? null : document.toJS(),
  );

  if (!parsed.success) {
    return null;
  }

  const skips: HookSkip[] = [];
  for (const harness of harnesses) {
    const skip = isHookHarness(harness)
      ? await hookIssue(harness, parsed.data, runtime)
      : { type: "no-command-hooks" as const };

    if (!skip) {
      return null;
    }

    skips.push(skip);
  }

  if (!skips.length) {
    return null;
  }

  return skips.some((skip) => skip.type === "missing-requirement")
    ? "cant-run"
    : "no-version";
}
