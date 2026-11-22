import { expect, test, vi } from "vitest";
import confirm from "@inquirer/confirm";
import input from "@inquirer/input";
import { askSecret, askUseUnassigned, readStdin } from "../ui/secret-input.js";

vi.mock("@inquirer/input", () => ({ default: vi.fn() }));
vi.mock("@inquirer/confirm", () => ({ default: vi.fn() }));

test("reusing an unassigned value is asked about by name, yes by default", async () => {
  vi.mocked(confirm).mockResolvedValue(false);

  expect(await askUseUnassigned("REGION")).toBe(false);
  expect(vi.mocked(confirm).mock.calls[0]![0]).toMatchObject({
    message:
      "BarnDog already keeps a value for REGION that no server has. Use it?",
    default: true,
  });
});

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
