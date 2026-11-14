import type { MoveResult } from "../features/migration/move.js";
import { bold, dim, hint, ok, table, warn } from "./format.js";

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
  if (result.direct) {
    output.push(`${ok("✔")} Added to ${result.branch}.`);
  } else if (result.branch) {
    output.push(
      result.url
        ? `Open the pull request: ${result.url}`
        : `Open a pull request from ${result.branch} on your Git host.`,
      dim("Your local copies stay active until it merges."),
    );
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
