import checkbox from "@inquirer/checkbox";
import select from "@inquirer/select";
import { CliError } from "../errors.js";
import type {
  Applied,
  Overrides,
  SelectionOutcome,
  SetAssets,
  SetPreview,
  SetSelection,
} from "../features/environment/operations.js";
import { runSelection, type SelectionContext } from "./selection.js";
import { checkboxTheme, promptTheme } from "./theme.js";
import type { ListAsset } from "./asset-list.js";

type InstallMode = "recommended" | "all" | "custom";

/** The set operations installing a set calls; `CommandContext` provides them. */
type SetInstallContext = SelectionContext & {
  installSet: (options: SetSelection) => Promise<SelectionOutcome>;
  previewSet: (origin: string) => Promise<SetPreview>;
  installSetAssets: (options: SetAssets) => Promise<Applied>;
};

/**
 * Installs a scope using an explicit mode or interactive asset selection, then
 * renders the selection result.
 */
export async function runSetInstall(
  context: SetInstallContext,
  options: {
    origin: string;
    mode?: "recommended" | "optional" | "all";
  } & Overrides,
  prompts: {
    interactive?: boolean;
    mode?: () => Promise<InstallMode>;
    assets?: (assets: ListAsset[], selectedIds: string[]) => Promise<string[]>;
  } = {},
) {
  const install = (mode: "recommended" | "optional" | "all") =>
    runSelection(context, (resolution) =>
      context.installSet({ ...options, mode, resolution }),
    );

  if (options.mode) {
    return install(options.mode);
  }

  if (!(
    prompts.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)
  )) {
    throw new CliError(
      "Choose which assets to include with --mode, or run this in a terminal to pick.",
      `barndog sets install ${options.origin} --mode recommended`,
    );
  }

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

  if (mode !== "custom") {
    return install(mode);
  }

  const preview = await context.previewSet(options.origin);
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

  await runSelection(context, () =>
    context.installSetAssets({ origin: options.origin, assetIds }),
  );
}
