import type { CommandContext } from "./context.js";
import { assetKinds, type AssetKind } from "../features/asset-kinds/index.js";
import { CliError } from "../errors.js";
import { pickOne } from "../ui/pick.js";
import { clean, originLabel } from "../ui/format.js";
import { only } from "../shared/lookup.js";

/**
 * Names are unique only within a scope, so `--origin` picks between scopes
 * that share one. When only one scope has the name, as in a local folder
 * with its single scope, the name alone identifies the asset.
 */
export async function resolveOrigin(
  context: Pick<CommandContext, "searchCatalog" | "mode">,
  kind: AssetKind,
  name: string,
  origin: string | undefined,
  usage: string,
): Promise<string> {
  if (origin) return origin;
  const rows = (await context.searchCatalog(kind)).filter(
    (row) => row.name === name || row.id === name,
  );
  if (!rows.length)
    throw new CliError(
      `No ${assetKinds[kind].one} named ${name} is available to you.`,
      `barndog ${assetKinds[kind].command} search ${name}`,
    );
  const labels = [...new Set(rows.map((row) => originLabel(row.origin)))];
  const single = only(labels);
  if (single) return single;
  if (!context.mode.interactive)
    throw new CliError(
      `${name} exists in several scopes: ${labels.join(", ")}. Choose one with --origin.`,
      `${usage} --origin ${labels[0]}`,
    );
  return pickOne(
    `${name} exists in several scopes. Which one?`,
    labels.map((label) => ({
      value: label,
      name: label,
      hint: clean(
        rows.find((row) => originLabel(row.origin) === label)?.version
          .description ?? "",
      ),
    })),
  );
}

/** Lets the person choose an installed asset when the command was given no name. */
export async function pickInstalled(
  context: Pick<CommandContext, "inventory" | "mode">,
  kind: AssetKind,
  usage: string,
): Promise<{ name: string; origin: string }> {
  if (!context.mode.interactive)
    throw new CliError(
      `Name the ${assetKinds[kind].one} to use, or run this in a terminal to choose from a list.`,
      usage,
    );
  const items = (await context.inventory()).items.filter(
    (item) => item.kind === kind && item.origin !== "—",
  );
  const item = await pickOne(
    `Choose a ${assetKinds[kind].one}`,
    items.map((item) => ({
      value: item,
      name: item.installedName,
      hint: `${item.origin} · ${item.state}`,
    })),
    { empty: `No ${assetKinds[kind].one}s are installed on this machine.` },
  );
  return { name: item.name, origin: item.origin };
}
