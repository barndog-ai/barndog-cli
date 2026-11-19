import { expect, test, vi } from "vitest";
import input from "@inquirer/input";
import { askSecret, readStdin } from "../ui/secret-input.js";

vi.mock("@inquirer/input", () => ({ default: vi.fn() }));

test("the prompt masks every character and names the variable", async () => {
  vi.mocked(input).mockResolvedValue("typed");

  expect(await askSecret("API_KEY")).toBe("typed");
  const options = vi.mocked(input).mock.calls[0]![0];
  expect(options.message).toBe("Value for API_KEY");
  expect(options.transformer?.("abc", { isFinal: false })).toBe("***");
});

test.each([
  [["value\n"], "value"],
  [["val", "ue\r\n"], "value"],
  [["two\nlines\n"], "two\nlines"],
  [[Buffer.from("bytes")], "bytes"],
])("standard input %j reads as %j", async (chunks, expected) => {
  async function* stream() {
    yield* chunks;
  }

  expect(await readStdin(stream())).toBe(expected);
});
