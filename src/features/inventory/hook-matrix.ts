import type { RuntimeContext } from "../../runtime.js";
import { hookCompatibility } from "../hooks/compatibility.js";
import type { HarnessCompatibility } from "../hooks/types.js";
import { inventory } from "./index.js";

/** One selected Hook's support in each tool BarnDog manages, for `hooks compatibility --all`. */
export type HookCompatibilityRow = {
  name: string;
  origin: string;
  compatibility: HarnessCompatibility[];
};

/** Every selected Hook's support and readiness per tool, in the inventory's order. */
export async function allHookCompatibility(
  runtime: RuntimeContext,
): Promise<HookCompatibilityRow[]> {
  const { items } = await inventory(runtime);

  // Leftovers have no origin to look them up by: they are no longer selected.
  const hooks = items.filter(
    (item) => item.kind === "hook" && item.origin !== "—",
  );

  return Promise.all(
    hooks.map(async (item) => ({
      name: item.installedName,
      origin: item.origin,
      compatibility: (await hookCompatibility(item.name, item.origin, runtime))
        .compatibility,
    })),
  );
}
