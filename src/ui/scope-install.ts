import checkbox from "@inquirer/checkbox";
import select from "@inquirer/select";
import { CliError } from "../errors.js";
import type { EnvironmentOptions } from "../features/environment/operations.js";
import { runSelection, type SelectionContext } from "./selection.js";
import { checkboxTheme, promptTheme } from "./theme.js";
import type { ListAsset } from "./asset-list.js";

type InstallMode = "recommended" | "all" | "custom";

export async function runSetInstall(
  context: SelectionContext,
  options: EnvironmentOptions,
  prompts: {
    interactive?: boolean;
    mode?: () => Promise<InstallMode>;
    assets?: (assets: ListAsset[], selectedIds: string[]) => Promise<string[]>;
  } = {},
) {
  if (options.mode) return runSelection(context, "sets-install", options);
  if (!(
    prompts.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)
  ))
    throw new CliError(
      "Choose which assets to include with --mode, or run this in a terminal to pick.",
      `barndog sets install ${options.origin} --mode recommended`,
    );
  const mode = await (
    prompts.mode ??
    (() =>
      select<InstallMode>({
        loop: false,
        message: `What would you like to install from ${options.origin}?`,
        choices: [
          { name: "All assets", value: "all" },
          { name: "Recommended only", value: "recommended" },
          { name: "Custom — choose assets", value: "custom" },
        ],
        default: "recommended",
        theme: promptTheme,
      }))
  )();
  if (mode !== "custom")
    return runSelection(context, "sets-install", { ...options, mode });
  const preview = (await context.environment("sets-preview", options)) as {
    assets: ListAsset[];
    selectedAssetIds: string[];
  };
  if (!preview.assets.length) {
    context.write("No published assets in this source yet.");
    return;
  }
  const assetIds = await (
    prompts.assets ??
    ((assets, selectedIds) =>
      checkbox({
        loop: false,
        message: `Choose assets from ${options.origin}`,
        choices: assets.map((asset) => ({
          name: asset.name,
          value: asset.id,
          checked: selectedIds.includes(asset.id),
        })),
        pageSize: 8,
        theme: checkboxTheme,
      }))
  )(preview.assets, preview.selectedAssetIds);
  if (!assetIds.length) {
    context.write("No assets selected. Nothing changed.");
    return;
  }
  await runSelection(context, "sets-install-custom", { ...options, assetIds });
}
