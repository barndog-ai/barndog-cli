import { expect, test, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import {
  bad,
  badge,
  dim,
  ok,
  warn,
  fields,
  renderValue,
  table,
  visibleWidth,
} from "../ui/format.js";

// Tests run with FORCE_COLOR=0 (setup.ts), where every style is plain text, so
// a badge's color can only be checked with color forced on.
const tones = { ok, warn, bad, dim };
for (const [state, tone] of [
  ["installed", "ok"],
  ["enabled", "ok"],
  ["unsupported", "warn"],
  ["clash", "warn"],
  ["pending", "warn"],
  ["skipped", "warn"],
  ["missing", "bad"],
  ["unavailable", "bad"],
  ["disabled", "dim"],
] as const) {
  test(`${state} badge is styled ${tone} and keeps its label`, () => {
    vi.stubEnv("FORCE_COLOR", "1");
    try {
      const styled = badge(state, "Label");
      expect(styled).not.toBe("Label");
      expect(styled).toBe(tones[tone]("Label"));
      expect(stripVTControlCharacters(styled)).toBe("Label");
    } finally {
      vi.unstubAllEnvs();
    }
  });
}

test("badge tones are distinguishable when color is on", () => {
  vi.stubEnv("FORCE_COLOR", "1");
  try {
    const styles = Object.values(tones).map((tone) => tone("Label"));
    expect(new Set(styles).size).toBe(styles.length);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("structured fallback handles plain values, missing values and heterogeneous lists", () => {
  for (const [value, expected] of [
    [null, "—"],
    [true, "true"],
    [false, "false"],
    [0, "0"],
    ["text", "text"],
  ] as const) {
    expect(renderValue(value)).toEqual([expected]);
  }

  expect(renderValue(undefined)).toEqual([]);
  expect(renderValue([])).toEqual(["None."]);
  expect(
    renderValue([{ nested: {} }, { nested: { other: true } }]).join("\n"),
  ).toContain("Other");

  expect(renderValue(["text", { value: null }, 2]).join("\n")).toContain(
    "text",
  );

  expect(
    renderValue([
      { SOME_ENV: "value", optional: null },
      { SOME_ENV: "other" },
    ]).join("\n"),
  ).toContain("SOME_ENV");

  expect(
    renderValue({
      nested: [{ camelCase: true }],
      absent: undefined,
      number: 2,
    }).join("\n"),
  ).toContain("Camel case");

  expect(
    fields([
      ["Absent", undefined],
      ["Null", null],
      ["Empty", ""],
    ]),
  ).toEqual([]);
});

test("tables handle missing cells, empty rows and narrow explicit widths", () => {
  expect(table([])).toEqual([]);
  expect(table([[]])).toEqual([""]);
  expect(
    table([["A"], ["B", "C"]], { header: ["One", "Two"], width: 30 }),
  ).toEqual(["  One  Two", "  A", "  B    C"]);

  const ansi = "\u001b[31mthis name is far too long\u001b[0m text";
  const result = table([[ansi, "tail"]], { flex: 0, width: 20, indent: 0 });
  expect(result[0]).toContain("…");
  expect(result[0]).toMatch(/tail$/);
  expect(visibleWidth(result[0]!)).toBeLessThanOrEqual(20);
});
