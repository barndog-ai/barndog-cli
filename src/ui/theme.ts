import { styleText } from "node:util";

export const PRIMARY_COLOR = "#C54836";

export const SELECTION_COLOR = "green";

export function selected(
  text: string,
  stream: NodeJS.WriteStream = process.stdout,
): string {
  return styleText(SELECTION_COLOR, text, { stream });
}

/** The color depth `FORCE_COLOR` asks for, in bits. */
function forcedColorDepth() {
  if (process.env.FORCE_COLOR === "3") {
    return 24;
  }

  return process.env.FORCE_COLOR === "2" ? 8 : 4;
}

/** The SGR foreground code for the brand color at a color depth: exact, nearest of 256, or red. */
function primaryColorCode(depth: number, rgb: number[]) {
  if (depth >= 24) {
    return `38;2;${rgb.join(";")}`;
  }

  return depth >= 8 ? "38;5;131" : "31";
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
  const rgb = [1, 3, 5].map((start) =>
    parseInt(PRIMARY_COLOR.slice(start, start + 2), 16),
  );

  const color = primaryColorCode(depth, rgb);

  const start = `\u001b[${color}m`;

  return `${start}${text.replaceAll("\u001b[39m", start)}\u001b[39m`;
}

export const DANGER_COLOR = "red";

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

export const checkboxTheme = {
  ...promptTheme,
  icon: { ...promptTheme.icon, checked: selected(" ◉"), unchecked: " ◯" },
};
