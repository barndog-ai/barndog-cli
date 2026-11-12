import { adapters } from "../harnesses/registry.js";
import type { Harness } from "../harnesses/types.js";
import type {
  InventoryItem,
  InventoryState,
} from "../features/inventory/index.js";
import type { CatalogAsset } from "../features/catalog/index.js";
import { assetPage, type ListOptions } from "./asset-list.js";
import { displayPath } from "./output.js";
import {
  badge,
  bold,
  clean,
  dim,
  hint,
  ok,
  originLabel,
  plural,
  section,
  table,
} from "./format.js";

export const harnessNames = (harnesses: readonly Harness[]) =>
  harnesses.map((h) => adapters[h].name).join(", ");

/** An asset as `list` shows it: on this machine, or one that could be installed. */
export type ListedAsset = Omit<InventoryItem, "state"> & {
  state: InventoryState | "available";
};

export type ListFilter = {
  installed?: boolean;
  disabled?: boolean;
  available?: boolean;
};

const listGroup = (state: ListedAsset["state"]) =>
  state === "available"
    ? "available"
    : state === "disabled"
      ? "disabled"
      : "installed";

/** Installed first, then disabled, then available; no filter means all three. */
export function assetListing(
  items: readonly InventoryItem[],
  rows: readonly CatalogAsset[],
  filter: ListFilter,
): ListedAsset[] {
  const onMachine = new Set(items.map((item) => item.id));
  const available = rows
    .filter((row) => !onMachine.has(row.id))
    .map((row): ListedAsset => ({
      id: row.id,
      kind: row.kind,
      name: clean(row.name),
      installedName: clean(row.name),
      origin: originLabel(row.origin),
      via: [],
      state: "available",
      harnesses: [],
      paths: [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const order = ["installed", "disabled", "available"] as const;
  const wanted = order.filter((group) => filter[group]);
  return order
    .filter((group) => !wanted.length || wanted.includes(group))
    .flatMap((group) =>
      [...items, ...available].filter(
        (item) => listGroup(item.state) === group,
      ),
    );
}

const stateLabel: Record<ListedAsset["state"], string> = {
  available: "available",
  installed: "installed",
  disabled: "disabled",
  pending: "pending",
  outdated: "update available",
  clash: "clash",
  modified: "edited by hand",
  removing: "pending removal",
};

/** One table of what is selected and installed, with an optional path listing. */
export function renderInventory(
  items: readonly ListedAsset[],
  options: { paths?: boolean; heading?: string } = {},
): string[] {
  const output: string[] = [];
  if (options.heading)
    output.push(`${section(options.heading)} ${dim(`(${items.length})`)}`);
  output.push(
    ...table(
      items.map((item) => [
        bold(item.installedName) +
          (item.installedName !== item.name ? dim(" (renamed)") : ""),
        item.origin,
        dim(item.via.join(", ") || "—"),
        dim(
          item.harnesses.length
            ? item.harnesses.map((h) => adapters[h].name).join(", ")
            : "—",
        ),
        badge(
          item.state === "outdated"
            ? "pending"
            : item.state === "modified"
              ? "clash"
              : item.state,
          stateLabel[item.state],
        ),
      ]),
      { header: ["Name", "Origin", "Via", "Installed in", "State"], flex: 2 },
    ),
  );
  if (options.paths)
    for (const item of items) {
      if (!item.paths.length) continue;
      output.push(
        "",
        `  ${bold(item.installedName)}${item.installedName !== item.name ? dim(` · published as ${item.name}`) : ""}`,
      );
      for (const path of item.paths)
        output.push(dim(`    ${displayPath(path)}`));
    }
  return output;
}

/** Follow-up advice for states that need action. */
export function inventoryHints(items: readonly InventoryItem[]): string[] {
  const output: string[] = [];
  const count = (state: InventoryState) =>
    items.filter((item) => item.state === state).length;
  if (count("pending") || count("outdated") || count("removing"))
    output.push(
      hint("barndog sync", "Next") +
        dim(
          `  to apply ${plural(count("pending") + count("outdated") + count("removing"), "pending change")}`,
        ),
    );
  if (count("modified"))
    output.push(
      hint("barndog doctor", "Fix") +
        dim(`  to restore ${plural(count("modified"), "hand-edited asset")}`),
    );
  if (count("clash"))
    output.push(
      hint("barndog sync", "Fix") +
        dim("  in a terminal to choose how to resolve name clashes"),
    );
  return output;
}

export function renderCatalog(
  rows: CatalogAsset[],
  options: ListOptions,
  command: string,
  installedIds: ReadonlySet<string>,
): string[] {
  const page = assetPage(rows, options);
  if (!page.total) return [dim("No matching assets.")];
  if (!page.rows.length)
    return [
      `Page ${options.page} is empty. Choose a page from 1 to ${page.pages}.`,
    ];
  // Only Cloud has version numbers; local and Git assets are identified by a hash.
  const versioned = page.rows.some((row) => row.version.label === undefined);
  const output = table(
    page.rows.map((row) => [
      `${installedIds.has(row.id) ? ok("✔") : " "} ${bold(clean(row.name))}`,
      originLabel(row.origin),
      ...(versioned
        ? [dim(row.version.label ? "—" : `v${row.version.number}`)]
        : []),
      dim(clean(row.version.description)),
    ]),
    {
      header: [
        "  Name",
        "Origin",
        ...(versioned ? ["Ver"] : []),
        "Description",
      ],
    },
  );
  output.push(
    "",
    dim(
      `Showing ${page.start + 1}–${page.start + page.rows.length} of ${page.total}${page.pages > 1 ? ` · page ${options.page}/${page.pages}` : ""}${installedIds.size ? " · ✔ selected on this machine" : ""}`,
    ),
  );
  if (options.page < page.pages) {
    const filters = `${options.search ? ` ${JSON.stringify(options.search)}` : ""}${options.origin ? ` --origin ${options.origin}` : ""}`;
    output.push(
      hint(`${command}${filters} --page ${options.page + 1}`, "Next"),
    );
  }
  return output;
}
