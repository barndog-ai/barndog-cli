import select from "@inquirer/select";
import confirm from "@inquirer/confirm";
import type { CommandContext, Mode } from "../commands/context.js";
import { CliError } from "../errors.js";
import type { EnvironmentOptions } from "../features/environment/operations.js";
import type {
  OverrideConflict,
  OverrideResolution,
} from "../features/asset-selection/types.js";
import { json } from "./format.js";
import { renderSyncOutput } from "./output.js";
import { promptTheme } from "./theme.js";

export type SelectionContext = Pick<CommandContext, "environment" | "write"> & {
  mode?: Pick<Mode, "json">;
};

export async function runSelection(
  context: SelectionContext,
  action: string,
  options: EnvironmentOptions,
) {
  while (true) {
    const result = (await context.environment(action, options)) as {
      status: string;
      events?: Parameters<typeof renderSyncOutput>[0];
      conflicts?: OverrideConflict[];
    };
    if (result.status !== "decision-required") {
      if (context.mode?.json) {
        context.write(json(result));
        return;
      }
      for (const line of renderSyncOutput(result.events ?? []))
        context.write(line);
      return;
    }
    if (context.mode?.json || !process.stdin.isTTY || !process.stdout.isTTY)
      throw new CliError(
        "Existing exclusions or disable overrides need a decision.",
        "add --overrides preserve, --overrides clear or --decisions <file>",
      );
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
    let resolution: OverrideResolution;
    if (type === "per-asset") {
      const decisions: { assetId: string; choice: "preserve" | "clear" }[] = [];
      for (const conflict of result.conflicts ?? [])
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
      resolution = { type: "per-asset", decisions };
    } else resolution = { type: type as "preserve-all" | "clear-all" };
    options = { ...options, resolution };
  }
}
