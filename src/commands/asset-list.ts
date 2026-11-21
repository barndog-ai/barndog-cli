import { type Command } from "commander";
import { type CommandContext } from "./context.js";
import { type AssetKind } from "../config/selection.js";
import { type InventoryItem } from "../features/inventory/index.js";
import { friendlyMessage } from "../errors.js";
import {
  assetListOptions,
  pageOptions,
  filterAssets,
  type ListOptions,
} from "../ui/asset-list.js";
import {
  assetListing,
  inventoryHints,
  type ListFilter,
  renderCatalog,
  renderInventory,
} from "../ui/assets.js";
import { dim, hint, json } from "../ui/format.js";
import { assetKinds } from "../features/asset-kinds/index.js";
import { addArguments } from "./arguments.js";
import { unsetVariableNotes } from "../ui/mcp.js";

type ListCommandOptions = ListFilter & {
  paths?: boolean;
  page: number;
  limit: number;
};

/** `list`: installed, disabled and available assets of one kind. */
export function registerList(
  command: Command,
  kind: AssetKind,
  context: CommandContext,
) {
  const labels = assetKinds[kind];
  const group = assetKinds[kind].command;
  const addCommand = `barndog ${assetKinds[kind].command} add${addArguments[kind]}`;

  const listCommand = command
    .command("list")
    .description(`List installed, disabled and available ${labels.many}`);

  pageOptions(listCommand)
    .option("--installed", `Only ${labels.many} installed on this machine`)
    .option("--disabled", `Only ${labels.many} you've disabled`)
    .option("--available", `Only ${labels.many} you can install`)
    .option("--paths", "Show installed folders and configuration files")
    .action(async (options: ListCommandOptions) => {
      const narrowed = options.installed || options.disabled;
      const onlyAvailable = options.available && !narrowed;
      let catalogProblem: string | undefined;
      const [inventory, rows] = await Promise.all([
        context.inventory({ checkVariables: kind === "mcp" }),
        options.available || !narrowed
          ? context.searchCatalog(kind).catch((error: unknown) => {
              // JSON has nowhere to say the list is partial, so it fails;
              // --installed and --disabled don't need the catalog.
              if (onlyAvailable || context.mode.json) {
                throw error;
              }

              catalogProblem = friendlyMessage(error);

              return [];
            })
          : [],
      ]);

      const items = inventory.items.filter((item) => item.kind === kind);
      const listing = assetListing(items, rows, options);
      if (context.mode.json) {
        return context.write(json(listing));
      }

      if (inventory.offline) {
        context.write(dim(`Showing local state only: ${inventory.offline}`));
      } else if (catalogProblem) {
        context.write(
          dim(`Couldn't load available ${labels.many}: ${catalogProblem}`),
        );
      }

      if (!listing.length) {
        if (narrowed) {
          context.write(`No ${labels.many} match that filter.`);

          return;
        }

        if (catalogProblem || inventory.offline) {
          context.write(`No ${labels.many} on this machine yet.`);

          return;
        }

        context.write(`No ${labels.many} yet.`);
        context.write(hint(addCommand, "Next"));

        return;
      }

      const start = (options.page - 1) * options.limit;
      const page = listing.slice(start, start + options.limit);
      if (!page.length) {
        context.write(
          `Page ${options.page} is empty. Choose a page from 1 to ${Math.ceil(listing.length / options.limit)}.`,
        );

        return;
      }

      for (const line of renderInventory(page, {
        ...options,
        runtime: context.runtime,
      })) {
        context.write(line);
      }

      if (listing.length > options.limit) {
        const flags = (["installed", "disabled", "available"] as const)
          .filter((flag) => options[flag])
          .map((flag) => ` --${flag}`)
          .join("");

        context.write(
          "\n" +
            dim(
              `Showing ${start + 1}–${start + page.length} of ${listing.length}`,
            ),
        );

        if (start + page.length < listing.length) {
          context.write(
            hint(
              `barndog ${group} list${flags} --page ${options.page + 1}`,
              "Next",
            ),
          );
        }
      }

      const onThisMachine = page.filter(
        (item): item is InventoryItem => item.state !== "available",
      );

      for (const line of unsetVariableNotes(onThisMachine)) {
        context.write(line);
      }

      const hints = inventoryHints(onThisMachine);
      if (hints.length) {
        context.write(["", ...hints].join("\n"));
      } else if (!options.paths && onThisMachine.length) {
        context.write(
          "\n" +
            hint(`barndog ${group} list --paths`, "Tip") +
            dim("  to see where each one lives"),
        );
      }
    });
}

/** `search`: the kind's published catalog, filtered locally. */
export function registerSearch(
  command: Command,
  kind: AssetKind,
  context: CommandContext,
) {
  const labels = assetKinds[kind];
  const group = assetKinds[kind].command;

  const search = async (
    assetKind: AssetKind,
    query: string | undefined,
    options: Omit<ListOptions, "search">,
  ) => {
    const [rows, inventory] = await Promise.all([
      context.searchCatalog(assetKind),
      context.inventory().catch(() => undefined),
    ]);

    const selected = new Set(
      inventory?.items
        .filter((item) => item.state !== "removing")
        .map((item) => item.id) ?? [],
    );

    // JSON gets the same matches the table shows, all pages at once.
    if (context.mode.json) {
      return context.write(
        json(
          filterAssets(rows, { ...options, search: query }).map((row) => ({
            ...row,
            selected: selected.has(row.id),
          })),
        ),
      );
    }

    for (const line of renderCatalog(
      rows,
      { ...options, search: query },
      {
        command: `barndog ${group} search`,
        platform: context.runtime.platform,
      },
      selected,
    )) {
      context.write(line);
    }
  };

  assetListOptions(
    command
      .command("search [query]")
      .description(`Browse ${labels.many} published in your workspace`),
    false,
  ).action((query: string | undefined, options: ListOptions) =>
    search(kind, query ?? options.search, options),
  );
}
