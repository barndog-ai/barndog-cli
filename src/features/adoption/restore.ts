import { rm } from "node:fs/promises";

import { readState } from "../../config/state.js";
import type { RuntimeContext } from "../../runtime.js";
import { synchronize } from "../environment/sync.js";
import { installed } from "./copies.js";
import { putBack } from "./originals.js";
import { writeAdoption, type AdoptedItem, type Adoption } from "./record.js";

/**
 * Removes BarnDog's copies of `items`, syncs so its installations go, and puts
 * the originals back. Safe to run again: each step checks what is still to do.
 */
export async function restore(
  record: Adoption,
  items: AdoptedItem[],
  runtime: RuntimeContext,
) {
  const { home } = runtime;

  for (const copy of new Set(items.map((item) => item.copy))) {
    await rm(copy, { recursive: true, force: true });
  }

  const state = await readState(home);
  if (items.some((item) => installed(item, state))) {
    await synchronize(undefined, runtime, undefined, { prompt: false });
  }

  for (const item of items) {
    await putBack(item.harness, item.original, item.backup, runtime);
    item.undone = true;
  }

  record.status = record.items.every((item) => item.undone)
    ? "undone"
    : "applied";

  await writeAdoption(record, home);
}
