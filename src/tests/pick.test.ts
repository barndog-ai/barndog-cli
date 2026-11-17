import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { NothingToDoError } from "../errors.js";
import { pickOne, pickMany } from "../ui/pick.js";

const terminal = vi.hoisted(() => ({
  input: undefined as PassThrough | undefined,
  output: undefined as PassThrough | undefined,
}));

vi.mock("@inquirer/core", async (original) => {
  const core = await original<typeof import("@inquirer/core")>();

  return {
    ...core,
    createPrompt: (view: Parameters<typeof core.createPrompt>[0]) => {
      const prompt = core.createPrompt(view);

      return (config: Parameters<typeof prompt>[0]) =>
        prompt(config, { input: terminal.input, output: terminal.output });
    },
  };
});

afterEach(() => {
  terminal.input?.destroy();
  terminal.output?.destroy();
  vi.restoreAllMocks();
});

function screen() {
  terminal.input = new PassThrough();
  terminal.output = new PassThrough();
  let text = "";
  terminal.output.on("data", (data) => {
    text += String(data);
  });

  return {
    text: () => text,
    key: async (key: string) => {
      terminal.input!.write(key);
      await setImmediate();
    },
  };
}

const UP = "\u001b[A";
const DOWN = "\u001b[B";
const BACKSPACE = "\u007f";

test("an empty single picker throws NothingToDoError with the default message", async () => {
  const error = await pickOne("Pick", []).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(NothingToDoError);
  expect(error).toHaveProperty("message", "Nothing to choose from.");
});

test("an empty multiple picker throws NothingToDoError with the caller's message", async () => {
  const error = await pickMany("Pick", [], { empty: "No assets" }).catch(
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(NothingToDoError);
  expect(error).toHaveProperty("message", "No assets");
});

const threeChoices = [
  { name: "Alpha", value: 1, hint: "first" },
  { name: "Beta", value: 2, hint: "second" },
  { name: "Gamma", value: 3, hint: "third" },
];

test("single picker chooses the first choice when up is pressed at the top", async () => {
  const ui = screen();
  const result = pickOne("Pick", threeChoices);

  await setImmediate();
  await ui.key(UP);
  await ui.key("\r");
  expect(await result).toBe(1);
});

test("single picker moves down and stops at the last choice", async () => {
  const ui = screen();
  const result = pickOne("Pick", threeChoices);

  await setImmediate();
  await ui.key(DOWN);
  await ui.key(DOWN);
  await ui.key(DOWN);
  await ui.key(DOWN);
  await ui.key("\r");
  expect(await result).toBe(3);
});

test("single picker filters by hint text", async () => {
  const ui = screen();
  const result = pickOne("Pick", threeChoices);

  await setImmediate();
  for (const letter of "second") {
    await ui.key(letter);
  }

  await ui.key("\r");
  expect(await result).toBe(2);
});

test("single picker with no match says so and recovers when the filter is cleared", async () => {
  const ui = screen();
  const result = pickOne("Pick", threeChoices);

  await setImmediate();
  for (const letter of "zzz") {
    await ui.key(letter);
  }

  expect(ui.text()).toContain("No matches");
  await ui.key("\r");
  expect(ui.text()).toContain("No matching item.");

  for (let i = 0; i < 3; i++) {
    await ui.key(BACKSPACE);
  }

  await ui.key("\r");
  expect(await result).toBe(1);
});

test("multiple picker keeps hidden and preset checks and returns choices in source order", async () => {
  const ui = screen();
  const result = pickMany("Pick", [
    { name: "Alpha", value: 1 },
    { name: "Beta", value: 2, checked: true },
    { name: "Gamma", value: 3 },
  ]);

  await setImmediate();
  // Check Gamma first, then Alpha behind a filter that hides Beta and Gamma.
  await ui.key(DOWN);
  await ui.key(DOWN);
  await ui.key(" ");
  for (const letter of "alp") {
    await ui.key(letter);
  }

  await ui.key("\t");
  await ui.key("\r");
  expect(await result).toEqual([1, 2, 3]);
});

test("multiple picker unchecks a choice that is toggled twice", async () => {
  const ui = screen();
  const result = pickMany("Pick", [
    { name: "Alpha", value: 1 },
    { name: "Beta", value: 2 },
  ]);

  await setImmediate();
  await ui.key(" ");
  await ui.key(" ");
  await ui.key(DOWN);
  await ui.key(" ");
  await ui.key("\r");
  expect(await result).toEqual([2]);
});

test("multiple picker requires a selection and clips long hints in narrow terminals", async () => {
  const ui = screen();
  const old = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", {
    value: 30,
    configurable: true,
  });

  try {
    const result = pickMany("Pick", [
      {
        name: "A",
        value: "a",
        hint: "a hint that is much longer than the available space",
      },
      { name: "B", value: "b" },
    ]);

    await setImmediate();
    await ui.key("\r");
    expect(ui.text()).toContain("Select at least one");
    expect(ui.text()).toContain("…");
    expect(ui.text()).not.toContain("available space");
    const widest = Math.max(
      ...stripVTControlCharacters(ui.text())
        .split(/[\r\n]/)
        .filter((line) => line.includes("◯"))
        .map((line) => line.length),
    );

    expect(widest).toBeLessThan(30);
    await ui.key("\t");
    await ui.key("\r");
    expect(await result).toEqual(["a"]);
  } finally {
    if (old) {
      Object.defineProperty(process.stdout, "columns", old);
    } else {
      Reflect.deleteProperty(process.stdout, "columns");
    }
  }
});
