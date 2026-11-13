/** Quotes text as one POSIX shell word: `it's` → `'it'\''s'`. */
export const shellQuote = (value: string) =>
  "'" + value.replaceAll("'", "'\\''") + "'";
