/** BarnDog's copy of an adopted asset: what it holds, and whether sync installed it. */
import { lstat, readFile } from "node:fs/promises";
import { basename } from "node:path";

import { packageFingerprint } from "@barndog-ai/api-contract/package";

import type { State } from "../../config/state.js";
import type { RuntimeContext } from "../../runtime.js";
import { ifExists } from "../../shared/files.js";
import { readDirectory } from "../workspace/directory.js";
import type { AdoptedItem } from "./record.js";

/** What BarnDog's copy holds now, to tell later whether someone edited it. */
export async function copyFingerprint(
  item: Pick<AdoptedItem, "kind" | "copy">,
  runtime: RuntimeContext,
) {
  if (item.kind === "mcp") {
    const data = await ifExists(readFile(item.copy));

    return data === null
      ? null
      : packageFingerprint([
          { path: basename(item.copy), data, executable: false },
        ]);
  }

  return (await ifExists(lstat(item.copy))) === null
    ? null
    : packageFingerprint(await readDirectory(item.copy, runtime));
}

/** Whether the last sync installed an adopted asset in the tool it came from. */
export function installed(item: AdoptedItem, state: State) {
  if (item.kind === "skill") {
    return state.links.some(
      (link) => link.id === item.assetId && link.harness === item.harness,
    );
  }

  return state.native.some(
    (entry) =>
      entry.id === item.assetId &&
      entry.harness === item.harness &&
      entry.kind === item.kind,
  );
}
