import { stripVTControlCharacters, styleText } from "node:util";
import { safe } from "./collaboration.js";
import { danger, primary, selected } from "./theme.js";

type Style = Parameters<typeof styleText>[0];

const paint = (style: Style, text: string) =>
  styleText(style, text, { stream: process.stdout });

export const bold = (text: string) => paint("bold", text);

export const dim = (text: string) => paint("dim", text);

export const warn = (text: string) => paint("yellow", text);

export const ok = (text: string) => selected(text);

export const bad = (text: string) => danger(text);

/** Removes terminal control sequences and folds whitespace in remote text. */
export function clean(value: unknown): string {
  return safe(value).replace(/\s+/g, " ").trim();
}

export function visibleWidth(text: string): number {
  return [...stripVTControlCharacters(text)].length;
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

// eslint-disable-next-line no-control-regex -- matches terminal style codes
const STYLE_CODE = new RegExp("(\\u001b\\[[0-9;]*m)");

function truncate(text: string, width: number): string {
  const plain = stripVTControlCharacters(text);
  if ([...plain].length <= width) return text;
  if (width <= 1) return "…";
  // Every style code is kept, so a cut cell looks like the uncut ones.
  let room = width - 1;
  let cut = false;
  let output = "";
  for (const part of text.split(STYLE_CODE)) {
    if (part.startsWith("\u001b[")) {
      output += part;
      continue;
    }
    if (cut) continue;
    const characters = [...part];
    if (characters.length <= room) {
      output += part;
      room -= characters.length;
      continue;
    }
    output += `${characters.slice(0, room).join("")}…`;
    cut = true;
  }
  return output;
}

export function heading(title: string): string {
  return `${primary(bold("BarnDog"))} ${bold(title)}`;
}

export function section(title: string): string {
  return bold(title);
}

export function hint(command: string, label: "Next" | "Fix" | "Tip" = "Next") {
  return `${dim(`${label}:`)} ${bold(command)}`;
}

/** Aligned key/value rows; empty values are omitted. */
export function fields(
  rows: readonly (readonly [string, string | undefined | null])[],
  indent = 0,
): string[] {
  const visible = rows.filter(
    (row): row is readonly [string, string] => !!row[1],
  );
  const width = Math.max(0, ...visible.map(([label]) => label.length));
  return visible.map(
    ([label, value]) =>
      `${" ".repeat(indent)}${dim(pad(label, width))}  ${value}`,
  );
}

export type TableOptions = {
  header?: readonly string[];
  indent?: number;
  /** The column that shrinks when the terminal is narrow; defaults to the last. */
  flex?: number;
  width?: number;
};

/** Aligned columns with ANSI-aware widths that fit the terminal. */
export function table(
  rows: readonly (readonly string[])[],
  options: TableOptions = {},
): string[] {
  const indent = " ".repeat(options.indent ?? 2);
  const all = options.header
    ? [options.header.map((cell) => dim(cell)), ...rows]
    : [...rows];
  if (!all.length) return [];
  const count = Math.max(...all.map((row) => row.length));
  const widths = Array.from({ length: count }, (_, column) =>
    Math.max(0, ...all.map((row) => visibleWidth(row[column] ?? ""))),
  );
  const flex = options.flex ?? count - 1;
  const available =
    (options.width ?? (process.stdout.columns || Infinity)) -
    indent.length -
    (count - 1) * 2;
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (total > available && widths[flex] !== undefined)
    widths[flex] = Math.max(8, widths[flex]! - (total - available));
  return all.map((row) =>
    (
      indent +
      widths
        .map((width, column) => {
          const cell = row[column] ?? "";
          const fitted =
            visibleWidth(cell) > width ? truncate(cell, width) : cell;
          return column === count - 1 ? fitted : pad(fitted, width);
        })
        .join("  ")
    ).trimEnd(),
  );
}

export type State =
  | "installed"
  | "enabled"
  | "disabled"
  | "unsupported"
  | "clash"
  | "skipped"
  | "missing"
  | "pending"
  | "unavailable";

export function badge(state: State | string, label: string = state): string {
  switch (state) {
    case "installed":
    case "enabled":
      return ok(label);
    case "unsupported":
    case "clash":
    case "pending":
    case "skipped":
      return warn(label);
    case "missing":
    case "unavailable":
      return bad(label);
    default:
      return dim(label);
  }
}

export { originLabel } from "../features/environment/names.js";

export function plural(count: number, noun: string, many = `${noun}s`) {
  return `${count} ${count === 1 ? noun : many}`;
}

export function humanize(value: string): string {
  const text = value.replaceAll("_", " ");
  return text[0]!.toUpperCase() + text.slice(1);
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export const ORIGIN_HELP =
  "Owning scope, such as org, team/engineering, repo/web-app or dev/john";

const isPlain = (value: unknown) =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

const show = (value: unknown) =>
  value === null || value === undefined ? dim("—") : clean(value);

const label = (key: string) =>
  // Environment variable names are data, not field labels.
  /^[A-Z][A-Z0-9_]*$/.test(key)
    ? key
    : humanize(key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());

/** Readable fallback for structured results: key/value blocks and tables. */
export function renderValue(value: unknown, indent = 0): string[] {
  if (isPlain(value)) return [`${" ".repeat(indent)}${show(value)}`];
  if (Array.isArray(value)) {
    if (!value.length) return [`${" ".repeat(indent)}${dim("None.")}`];
    if (
      value.every(
        (row) => row && typeof row === "object" && !Array.isArray(row),
      )
    ) {
      const keys = Object.keys(value[0] as object).filter((key) =>
        value.every((row) => isPlain((row as Record<string, unknown>)[key])),
      );
      if (keys.length)
        return table(
          value.map((row) =>
            keys.map((key) => show((row as Record<string, unknown>)[key])),
          ),
          { header: keys.map(label), indent: indent + 2 },
        );
    }
    return value.flatMap((row, index) => [
      ...(index ? [""] : []),
      ...renderValue(row, indent),
    ]);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const simple = entries.filter(([, v]) => isPlain(v));
  const nested = entries.filter(([, v]) => !isPlain(v) && v !== undefined);
  return [
    ...fields(
      simple.map(([key, v]) => [label(key), show(v)] as const),
      indent,
    ),
    ...nested.flatMap(([key, v]) => [
      `${" ".repeat(indent)}${bold(label(key))}`,
      ...renderValue(v, indent + 2),
    ]),
  ];
}
