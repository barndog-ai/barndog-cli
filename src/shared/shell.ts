/** Quotes text as one POSIX shell word: `it's` → `'it'\''s'`. */
export const posixQuote = (value: string) =>
  "'" + value.replaceAll("'", "'\\''") + "'";

/**
 * Text the shell reads as one word without quotes: `claude`, `v1.2-rc`, but
 * not `a b`, `$HOME` or `/usr/bin`.
 */
export const PLAIN_WORD = /^[\w.-]+$/;

/** One POSIX shell word, quoted only when it needs to be. */
export const posixWord = (value: string) =>
  PLAIN_WORD.test(value) ? value : posixQuote(value);

/**
 * Quotes text as one PowerShell word. PowerShell also ends a single-quoted
 * string at the typographic single quotes, so every one of them is doubled.
 */
export function powershellQuote(value: string) {
  let quoted = value;
  for (const quote of "'\u2018\u2019\u201A\u201B") {
    quoted = quoted.replaceAll(quote, quote + quote);
  }

  return `'${quoted}'`;
}
