import { styleText } from "node:util";

/** Node terminal color depth for 24-bit RGB. */
const TRUE_COLOR_DEPTH = 24;

/** Node terminal color depth for the 256-color palette. */
const PALETTE_COLOR_DEPTH = 8;

/** Node terminal color depth for the sixteen ANSI colors. */
const BASIC_COLOR_DEPTH = 4;

/** CSS #RRGGBB green channel starts at character three. */
const GREEN_HEX_OFFSET = 3;

/** CSS #RRGGBB blue channel starts at character five. */
const BLUE_HEX_OFFSET = 5;

/**
 * BarnDog brand accent, applied through `primary()` to headings, highlighted
 * output and prompt accents.
 */
const PRIMARY_COLOR = "#C54836";

const SELECTION_COLOR = "green";

/**
 * Applies the selection color using Node's color policy for the supplied stream
 * (stdout by default).
 */
export function selected(
  text: string,
  stream: NodeJS.WriteStream = process.stdout,
): string {
  return styleText(SELECTION_COLOR, text, { stream });
}

/** The color depth `FORCE_COLOR` asks for, in bits. */
function forcedColorDepth() {
  if (process.env.FORCE_COLOR === "3") {
    return TRUE_COLOR_DEPTH;
  }

  return process.env.FORCE_COLOR === "2"
    ? PALETTE_COLOR_DEPTH
    : BASIC_COLOR_DEPTH;
}

/** The SGR foreground code for the brand color at a color depth: exact, nearest of 256, or red. */
function primaryColorCode(depth: number, rgb: number[]) {
  if (depth >= TRUE_COLOR_DEPTH) {
    return `38;2;${rgb.join(";")}`;
  }

  return depth >= PALETTE_COLOR_DEPTH ? "38;5;131" : "31";
}

/** Exact brand color on true-color terminals, with palette and plain-text fallbacks. */
export function primary(
  text: string,
  stream: NodeJS.WriteStream = process.stdout,
): string {
  // Let Node handle NO_COLOR, NODE_DISABLE_COLORS, FORCE_COLOR, and terminal detection.
  if (styleText("bold", "x", { stream }) === "x") {
    return text;
  }

  const depth = stream.getColorDepth?.() ?? forcedColorDepth();
  const rgb = [1, GREEN_HEX_OFFSET, BLUE_HEX_OFFSET].map((start) =>
    parseInt(PRIMARY_COLOR.slice(start, start + 2), 16),
  );

  const color = primaryColorCode(depth, rgb);

  const start = `\u001b[${color}m`;

  return `${start}${text.replaceAll("\u001b[39m", start)}\u001b[39m`;
}

const DANGER_COLOR = "red";

export function danger(
  text: string,
  stream: NodeJS.WriteStream = process.stdout,
): string {
  return styleText(DANGER_COLOR, text, { stream });
}

export const promptTheme = {
  prefix: { idle: styleText("dim", "?"), done: selected("✔") },
  icon: { cursor: primary("❯") },
  style: { answer: primary, highlight: primary, description: primary },
};

/**
 * `promptTheme` with BarnDog's checked and unchecked circles, for multi-select
 * prompts.
 */
export const checkboxTheme = {
  ...promptTheme,
  icon: { ...promptTheme.icon, checked: selected(" ◉"), unchecked: " ◯" },
};
