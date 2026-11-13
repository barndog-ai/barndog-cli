import { InvalidArgumentError, type Command } from "commander";

import { originLabel } from "../features/environment/names.js";
import { POSITIVE_INTEGER } from "../shared/patterns.js";

export type ListOptions = {
  search?: string;
  origin?: string;
  page: number;
  limit: number;
};

export type ListAsset = {
  id: string;
  name: string;
  origin: { type: string; slug?: string; id?: string };
  version?: { number: number; description?: string };
};

function positive(value: string) {
  if (!POSITIVE_INTEGER.test(value) || !Number.isSafeInteger(Number(value)))
    throw new InvalidArgumentError("Use a positive integer");
  return Number(value);
}

export function assetListOptions(command: Command, withSearch = true): Command {
  if (withSearch)
    command.option(
      "--search <keywords>",
      "Search names, descriptions and origins",
    );
  return pageOptions(
    command.option(
      "--origin <origin>",
      "Filter by scope, such as org, team/engineering, repo/web-app or dev/john",
    ),
  );
}

export function pageOptions(command: Command): Command {
  return command.option("--page <number>", "Results page", positive, 1).option(
    "--limit <number>",
    "Results per page (maximum 100)",
    (value) => {
      const count = positive(value);
      if (count > 100)
        throw new InvalidArgumentError("Use at most 100 results per page");
      return count;
    },
    20,
  );
}

/** Rows that match the search words and origin, in display order. */
export function filterAssets<T extends ListAsset>(
  rows: T[],
  options: Pick<ListOptions, "search" | "origin">,
) {
  const terms =
    options.search?.toLocaleLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const origin = options.origin?.replace(":", "/");
  return rows
    .filter((row) => {
      const path = originLabel(row.origin);
      const text =
        `${row.name} ${row.version?.description ?? ""} ${path}`.toLocaleLowerCase();
      return (
        (!origin ||
          path === origin ||
          row.origin.type === origin ||
          row.origin.id === origin) &&
        terms.every((term) => text.includes(term))
      );
    })
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        (a.origin.slug ?? "").localeCompare(b.origin.slug ?? "") ||
        a.id.localeCompare(b.id),
    );
}

export function assetPage<T extends ListAsset>(
  rows: T[],
  options: ListOptions,
) {
  const filtered = filterAssets(rows, options);
  const start = (options.page - 1) * options.limit;
  if (!Number.isSafeInteger(start)) throw new Error("Page number is too large");
  return {
    rows: filtered.slice(start, start + options.limit),
    total: filtered.length,
    start,
    pages: Math.max(1, Math.ceil(filtered.length / options.limit)),
  };
}
