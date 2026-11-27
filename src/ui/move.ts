import select from "@inquirer/select";
import type { LocalAssets, MoveResult } from "../features/migration/move.js";
import { bold, dim, hint, ok, table, warn } from "./format.js";
import { pickMany } from "./pick.js";
import { promptTheme } from "./theme.js";

/** The local assets `local move` can take: valid, and not already moving. */
export function pickLocalAssets(local: LocalAssets): Promise<string[]> {
  return pickMany(
    "Which local assets should move?",
    local.assets
      .filter((asset) => asset.state === "available")
      .map((asset) => ({
        value: asset.name,
        name: asset.name,
        columns: [dim(asset.kind)],
      })),
    { empty: "No local assets can be moved." },
  );
}

/** True keeps separate local copies; false makes the shared copies the only ones. */
export function chooseKeepLocal(count: number): Promise<boolean> {
  const them = count === 1 ? "it" : "them";

  return select<boolean>({
    loop: false,
    message: `Move ${them}, or share a copy and keep ${them} here too?`,
    choices: [
      {
        name: "Move",
        value: false,
        description: `The shared copy becomes the only one. Once it exists, the next sync installs it and removes the local copy.`,
      },
      {
        name: "Keep a separate local copy",
        value: true,
        description: `Shares a copy. The local ${count === 1 ? "asset stays" : "assets stay"} on this machine as ${count === 1 ? "its" : "their"} own.`,
      },
    ],
    theme: promptTheme,
  });
}

export function renderMove(result: MoveResult): string[] {
  if (!result.rows.length) {
    return [dim("Nothing to move.")];
  }

  const output = table(
    result.rows.map((row) => [
      row.status === "moved" ? ok(row.status) : warn(row.status),
      dim(row.kind),
      bold(row.name),
      dim(row.detail ?? ""),
    ]),
    { header: ["Status", "Kind", "Name", ""] },
  );

  output.push("");
  const moved = result.rows.some((row) => row.status === "moved");
  if (result.direct && result.branch) {
    output.push(`${ok("✔")} Added to ${result.branch}.`);
  } else if (result.branch) {
    output.push(
      result.url
        ? `Open the pull request: ${result.url}`
        : `Open a pull request from ${result.branch} on your Git host.`,
    );
  }

  if (moved && result.keepLocal) {
    output.push(
      dim(
        "Your local copies stay as separate assets. Where one has the same name as its shared copy, sync asks which to rename.",
      ),
    );
  } else if (moved && result.direct) {
    output.push(
      dim("The shared copies are installed and the local ones removed."),
    );
  } else if (moved) {
    output.push(
      dim(
        "The move finishes when that merges: your local copies stay in use until then, and the next sync replaces them with the shared ones.",
      ),
    );
  }

  for (const path of result.removed) {
    output.push(dim(`Removed ${path}`));
  }

  for (const row of result.rows) {
    if (row.status === "clash") {
      output.push(
        hint(`barndog local move ${row.name} --as <new-name>`, "Fix"),
      );
    }
  }

  return output;
}
