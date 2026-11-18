/**
 * Which coding tools BarnDog manages. Changing the list syncs at once: a tool
 * taken off loses every Skill link, MCP entry, Hook and session-start
 * registration BarnDog wrote there, and later syncs leave it alone; a tool put
 * back receives the current selection. Asset selections are kept either way.
 */
import type { RuntimeContext } from "../../runtime.js";
import { detectHarnesses } from "../../harnesses/detect.js";
import { harnesses, type DetectedHarness } from "../../harnesses/registry.js";
import type { Harness } from "../../harnesses/types.js";
import { locked } from "./transaction.js";
import { synchronize } from "./sync.js";
import { readRequiredSettings, type Applied } from "./operations.js";

/** A coding tool, whether it looks installed here, and whether BarnDog manages it. */
export type HarnessStatus = DetectedHarness & { enabled: boolean };

export type HarnessChange = "enable" | "disable";

/** A synced change, with the tools BarnDog manages after it in registry order. */
export type HarnessesApplied = Applied & { harnesses: Harness[] };

/** Every coding tool BarnDog supports, in registry order. */
export async function listHarnesses(
  runtime: RuntimeContext,
): Promise<HarnessStatus[]> {
  const settings = await readRequiredSettings(runtime);
  const detected = await detectHarnesses(runtime);

  return detected.map((harness) => ({
    ...harness,
    enabled: settings.harnesses.includes(harness.id),
  }));
}

/** Leaves the tools not named as they are. */
export function changeHarnesses(
  change: HarnessChange,
  targets: readonly Harness[],
  runtime: RuntimeContext,
): Promise<HarnessesApplied> {
  return applyHarnesses(runtime, (current) =>
    change === "enable"
      ? [...current, ...targets]
      : current.filter((harness) => !targets.includes(harness)),
  );
}

export function selectHarnesses(
  selected: readonly Harness[],
  runtime: RuntimeContext,
): Promise<HarnessesApplied> {
  return applyHarnesses(runtime, () => selected);
}

function applyHarnesses(
  runtime: RuntimeContext,
  next: (current: readonly Harness[]) => readonly Harness[],
): Promise<HarnessesApplied> {
  return locked(runtime, async () => {
    const settings = await readRequiredSettings(runtime);
    const chosen = new Set(next(settings.harnesses));
    // Registry order, so the saved list doesn't depend on the order typed.
    const managed = harnesses.filter((harness) => chosen.has(harness));

    const events = await synchronize(undefined, runtime, {
      ...settings,
      harnesses: managed,
    });

    return { status: "applied", events, harnesses: managed };
  });
}
