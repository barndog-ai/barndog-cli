import select from "@inquirer/select";
import confirm from "@inquirer/confirm";
import { CliError } from "../errors.js";
import type { SelectionOutcome } from "../features/environment/operations.js";
import type { OverrideResolution } from "../features/asset-selection/types.js";
import { json } from "./format.js";
import { renderSyncOutput } from "./output.js";
import { promptTheme } from "./theme.js";

/** What selection prompts need from the command running them. */
export type SelectionContext = {
  write: (message: string) => void;
  mode?: { json: boolean };
};

/** A change that would undo exclusions or disabled assets runs again with the answer. */
export async function runSelection(
  context: SelectionContext,
  change: (resolution?: OverrideResolution) => Promise<SelectionOutcome>,
) {
  let resolution: OverrideResolution | undefined;
  while (true) {
    const result = await change(resolution);
    if (result.status !== "decision-required") {
      if (context.mode?.json) {
        context.write(json(result));

        return;
      }

      for (const line of renderSyncOutput(result.events)) {
        context.write(line);
      }

      return;
    }

    if (context.mode?.json || !process.stdin.isTTY || !process.stdout.isTTY) {
      throw new CliError(
        "Existing exclusions or disable overrides need a decision.",
        "add --overrides preserve, --overrides clear or --decisions <file>",
      );
    }

    const type = await select({
      loop: false,
      message: "Existing exclusions or disabled assets",
      theme: promptTheme,
      choices: [
        { value: "preserve-all", name: "Preserve all choices" },
        { value: "clear-all", name: "Clear all matching choices" },
        { value: "per-asset", name: "Choose for each asset" },
      ],
    });

    if (type === "per-asset") {
      const decisions: { assetId: string; choice: "preserve" | "clear" }[] = [];
      for (const conflict of result.conflicts) {
        decisions.push({
          assetId: conflict.asset.id,
          choice: (await confirm({
            message: `Clear overrides for ${conflict.asset.name}?`,
            default: false,
            theme: promptTheme,
          }))
            ? "clear"
            : "preserve",
        });
      }

      resolution = { type: "per-asset", decisions };
    } else {
      resolution = { type };
    }
  }
}
