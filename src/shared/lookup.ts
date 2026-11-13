/** `value`, or an Error saying `message` when a lookup the code relies on comes back empty. */
export function defined<T>(value: T | null | undefined, message: string): T {
  if (value === undefined || value === null) throw new Error(message);
  return value;
}

/** The one element of `items`, or undefined when there are none or several. */
export function only<T>(items: readonly T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}
