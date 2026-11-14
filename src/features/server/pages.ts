/** One page of a cursor-paginated list: its items and the cursor of the next page. */
export type Page<T> = {
  items: readonly T[];
  nextCursor?: string | null;
};

/**
 * Every item of a cursor-paginated list, fetching pages until the server stops
 * returning a cursor. A cursor the server already returned means it would loop
 * forever, so that fails as a broken server response.
 */
export async function allPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    if (page.nextCursor && seen.has(page.nextCursor)) {
      throw new Error("The server sent an invalid page of results");
    }

    if (page.nextCursor) {
      seen.add(page.nextCursor);
    }

    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  return items;
}
