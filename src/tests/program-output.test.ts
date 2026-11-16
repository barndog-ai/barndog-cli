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
