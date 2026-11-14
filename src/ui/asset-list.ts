import { InvalidArgumentError, type Command } from "commander";

import { originLabel } from "../features/server/origin.js";
import { positiveInteger } from "./options.js";
import { CliError } from "../errors.js";

/** BarnDog catalog pagination permits at most one hundred results. */
const MAX_PAGE_SIZE = 100;

/** Show twenty catalog results per page by default. */
const DEFAULT_PAGE_SIZE = 20;

/** Asset-list filters and pagination inputs; page numbers are one-based. */
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

/**
 * Adds origin, paging and optional search flags to a Commander command,
 * mutating and returning it.
 */
export function assetListOptions(command: Command, withSearch = true): Command {
  if (withSearch) {
    command.option(
      "--search <keywords>",
      "Search names, descriptions and origins",
    );
  }

  return pageOptions(
    command.option(
      "--origin <origin>",
      "Filter by scope, such as org, team/engineering, repo/web-app or dev/john",
    ),
  );
}

/**
 * Adds positive page and limit flags to a command; defaults are page 1 and 20
 * rows, with a 100-row maximum.
 */
export function pageOptions(command: Command): Command {
  return command
    .option("--page <number>", "Results page", positiveInteger, 1)
    .option(
      "--limit <number>",
      "Results per page (maximum 100)",
      (value) => {
        const count = positiveInteger(value);
        if (count > MAX_PAGE_SIZE) {
          throw new InvalidArgumentError("Use at most 100 results per page");
        }

        return count;
      },
      DEFAULT_PAGE_SIZE,
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

/**
 * Filters and slices rows using one-based paging, returning totals and at least
 * one page even for empty results.
 */
export function assetPage<T extends ListAsset>(
  rows: T[],
  options: ListOptions,
) {
  const filtered = filterAssets(rows, options);
  const start = (options.page - 1) * options.limit;
  if (!Number.isSafeInteger(start)) {
    throw new CliError("That --page number is too large. Use a smaller one.");
  }

  return {
    rows: filtered.slice(start, start + options.limit),
    total: filtered.length,
    start,
    pages: Math.max(1, Math.ceil(filtered.length / options.limit)),
  };
}
