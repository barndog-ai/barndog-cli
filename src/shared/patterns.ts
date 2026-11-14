/**
 * Identifier shapes and text formats that several modules check. Each is
 * defined once here so the copies can't drift apart; `src/tests/patterns.test.ts`
 * covers them.
 */

/** A UUIDv4 in either case, such as `729b9d5a-4a8c-4aa7-9b8d-975a55ac373e`. */
export const UUID_V4 =
  /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

/**
 * A full SHA-1 Git object name in lowercase, as Git prints it:
 * `3f786850e387550fdab836ed7e6dc881de23001b`. SHA-256 repositories use 64
 * digits and don't match.
 */
export const GIT_OBJECT_ID = /^[\da-f]{40}$/;

/**
 * An asset, folder or slug name: lowercase letters and digits in words joined by
 * single hyphens, such as `code-review` or `team2`. Never `-a`, `a--b` or `A`.
 */
export const NAME = /^[a-z\d]+(?:-[a-z\d]+)*$/;

/** Turns any text into a {@link NAME}-shaped slug: `Team A/Review!` → `team-a-review`. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z\d]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * YAML front matter at the very start of a Markdown file, optionally after a
 * byte-order mark, with LF or CRLF line endings:
 *
 * ```text
 * ---
 * name: code-review
 * description: Reviews a diff
 * ---
 * Body…
 * ```
 */
const FRONT_MATTER = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/;

/**
 * Front matter split into original fences, YAML and body so edits can preserve
 * surrounding text.
 */
export type FrontMatter = {
  /** The opening `---` line, including any byte-order mark and its line break. */
  open: string;
  /** The YAML between the fences, without their line breaks. */
  yaml: string;
  /** The closing `---` line with its line break, if there is one. */
  close: string;
  /** Everything after the closing fence. */
  body: string;
};

/** Splits a Markdown file into its front matter and body; null when there is none. */
export function splitFrontMatter(text: string): FrontMatter | null {
  const match = FRONT_MATTER.exec(text);
  if (!match) {
    return null;
  }

  const [whole, open = "", yaml = "", close = ""] = match;

  return { open, yaml, close, body: text.slice(whole.length) };
}

/** A top-level `name:` line in YAML, such as `name: code-review` or `name : x`. */
const NAME_LINE = /^name[ \t]*:.*$/m;

/**
 * Sets the top-level `name:` in a YAML document (a `hook.yaml`, or the front
 * matter of a `SKILL.md`), adding it as the first line when there is none.
 * Only the first `name:` at the start of a line changes; nested keys are indented
 * and left alone.
 */
export function setYamlName(yaml: string, name: string): string {
  return NAME_LINE.test(yaml)
    ? yaml.replace(NAME_LINE, () => `name: ${name}`)
    : `name: ${name}\n${yaml}`;
}

/** A positive whole number as typed on the command line: `1`, `20`; never `0`, `01` or `1.5`. */
export const POSITIVE_INTEGER = /^[1-9]\d*$/;

/**
 * A name in CONSTANT_CASE, such as an environment variable (`API_KEY`) or an
 * error code (`KNOWLEDGE_NOT_FOUND`).
 */
export const CONSTANT_CASE = /^[A-Z][\dA-Z_]*$/;

/** An origin selector's scope type (`org`, `team`, `repo`, `dev`) and the slug or ID after it. */
export type OriginSelector = { type: string; value?: string };

/**
 * Splits an origin selector at its first `/` or `:`: `team/review` and
 * `team:review` → `{ type: "team", value: "review" }`; `org` → `{ type: "org" }`.
 * The value keeps any further separators: `repo/a/b` → `a/b`.
 */
export function splitOrigin(selector: string): OriginSelector {
  const separator = selector.search(/[/:]/);

  return separator < 0
    ? { type: selector }
    : {
        type: selector.slice(0, separator),
        value: selector.slice(separator + 1),
      };
}
