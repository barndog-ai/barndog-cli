import { expect, test } from "vitest";

import { programOutput } from "../platform.js";
import { testRuntime } from "./runtime.js";

const runtime = testRuntime(process.cwd());
const node = (script: string) => [process.execPath, ["-e", script]] as const;
const limits = { timeoutMs: 5000, maxBytes: 4096 };

test("returns a program's stdout", async () => {
  const [command, args] = node("console.log('claude 2.1.0')");
  expect(await programOutput(command, args, runtime, limits)).toBe(
    "claude 2.1.0\n",
  );
});

test("fails on a non-zero exit", async () => {
  const [command, args] = node("process.exit(3)");
  await expect(programOutput(command, args, runtime, limits)).rejects.toThrow(
    /exited with code 3/,
  );
});

test("stops a program that runs too long or prints too much", async () => {
  const [slow, wait] = node("setTimeout(() => {}, 10000)");
  await expect(
    programOutput(slow, wait, runtime, { ...limits, timeoutMs: 100 }),
  ).rejects.toThrow(/timed out/);

  const [loud, flood] = node("process.stdout.write('x'.repeat(10000))");
  await expect(programOutput(loud, flood, runtime, limits)).rejects.toThrow(
    /printed too much/,
  );
});

test("fails when the program doesn't exist", async () => {
  await expect(
    programOutput("barndog-no-such-program", [], runtime, limits),
  ).rejects.toThrow();
});

test("keeps a character split across chunks and limits bytes, not characters", async () => {
  // "é" is two bytes in UTF-8; the second arrives in a later chunk.
  const [split, halves] = node(
    "process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9])), 50)",
  );

  expect(await programOutput(split, halves, runtime, limits)).toBe("é");

  // 3,000 characters but 6,000 bytes, over the 4,096-byte limit.
  const [wide, text] = node("process.stdout.write('é'.repeat(3000))");
  await expect(programOutput(wide, text, runtime, limits)).rejects.toThrow(
    /printed too much/,
  );
});
