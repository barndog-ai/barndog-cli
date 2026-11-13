/**
 * Narrowing for values whose shape isn't known: parsed JSON, YAML and TOML,
 * especially config files other tools write.
 */

/** Whether `value` is a plain object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` when it's a plain object, otherwise an empty one: for config files written by other tools. */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** The strings in `value` when it's an array, otherwise none. */
export function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
