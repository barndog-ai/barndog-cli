import { styleText } from "node:util";

export const PRIMARY_COLOR = "#C54836";

export const SELECTION_COLOR = "green";

export function selected(
  text: string,
  stream: NodeJS.WriteStream = process.stdout,
): string {
  return styleText(SELECTION_COLOR, text, { stream });
}

/** Exact brand color on true-color terminals, with palette and plain-text fallbacks. */
export function primary(
  text: string,
  stream: NodeJS.WriteStream = process.stdout,
): string {
  // Let Node handle NO_COLOR, NODE_DISABLE_COLORS, FORCE_COLOR, and terminal detection.
  if (styleText("bold", "x", { stream }) === "x") return text;
  const forcedDepth =
    process.env.FORCE_COLOR === "3"
      ? 24
      : process.env.FORCE_COLOR === "2"
        ? 8
        : 4;
  const depth = stream.getColorDepth?.() ?? forcedDepth;
  const rgb = PRIMARY_COLOR.slice(1)
    .match(/../g)!
    .map((value) => parseInt(value, 16));
  const color =
    depth >= 24 ? `38;2;${rgb.join(";")}` : depth >= 8 ? "38;5;131" : "31";
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
