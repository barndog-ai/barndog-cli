import { expect, test, vi, afterEach } from "vitest";
import { stat, access } from "node:fs/promises";
import {
  findExecutable,
  runtimeExecutable,
  bashShell,
  installedApplication,
  unsetCommand,
  removeCommand,
  fixSteps,
  gitAccessCommand,
  shellWord,
} from "../platform.js";
import { testRuntime } from "./runtime.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  stat: vi.fn(),
  access: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

for (const error of [
  Object.assign(new Error("denied"), { code: "EACCES" }),
  Object.assign(new Error("not directory"), { code: "ENOTDIR" }),
  new Error("unknown"),
  Object.assign(new Error("disk"), { code: "EIO" }),
]) {
  test(`executable probes distinguish absence from unexpected failures (${error.message})`, async () => {
    vi.mocked(stat).mockRejectedValue(error);
    const runtime = testRuntime("/unused", {
      cwd: "/work",
      env: { PATH: "/bin" },
      platform: "linux",
    });

    const result = findExecutable("tool", runtime);
    const app = installedApplication({ name: "Tool" }, runtime);
    if (
      "code" in error &&
      (error.code === "EACCES" || error.code === "ENOTDIR")
    ) {
      await expect(result).resolves.toBeNull();
      await expect(app).resolves.toBeNull();
    } else {
      await expect(result).rejects.toBe(error);
      await expect(app).rejects.toBe(error);
    }
  });
}

test("Windows runtime falls back to Git Bash and preserves unexpected probe failures", async () => {
  const original =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );

  const executable = await original.stat(process.execPath);
  vi.mocked(stat).mockResolvedValue(executable);
  vi.mocked(access).mockResolvedValue(undefined);
  const runtime = testRuntime("C:\\user", {
    cwd: "C:\\work",
    env: { ProgramFiles: "C:\\Programs", PATH: "" },
    platform: "win32",
  });

  expect(await runtimeExecutable("sh", runtime)).toContain("bash.exe");
  expect(
    await bashShell({ ...runtime, env: { PATH: "C:\\bin" } }),
  ).toMatchObject({ command: expect.stringContaining("bash.com") });

  // System32's bash.exe starts WSL, not a Bash hooks can run in.
  await expect(
    bashShell({
      ...runtime,
      env: { PATH: "C:\\Windows\\System32", SystemRoot: "C:\\WINDOWS" },
    }),
  ).rejects.toThrow(/isn't installed/);

  const failure = Object.assign(new Error("disk"), { code: "EIO" });
  vi.mocked(stat).mockRejectedValue(failure);
  await expect(runtimeExecutable("bash", runtime)).rejects.toBe(failure);
  vi.mocked(stat).mockRejectedValue(
    Object.assign(new Error("missing"), { code: "ENOENT" }),
  );

  expect(await runtimeExecutable("bash", runtime)).toBeNull();
  expect(await findExecutable("node.exe", { ...runtime, env: {} })).toBeNull();
  expect(
    await installedApplication({ name: "Tool" }, { ...runtime, env: {} }),
  ).toBeNull();

  expect(unsetCommand("TOKEN", "win32")).toContain("Remove-Item Env:TOKEN");
  expect(removeCommand("C:\\file", "win32")).toContain("Remove-Item");
  expect(fixSteps(["one", "two"], "win32")).toBe("one; if ($?) { two }");
  expect(fixSteps(["one", "two", "three"], "win32")).toBe(
    "one; if ($?) { two; if ($?) { three } }",
  );

  expect(fixSteps(["one", "two"], "darwin")).toBe("one && two");
  expect(shellWord("plain-word", "darwin")).toBe("plain-word");
  expect(shellWord("it's here", "darwin")).toBe("'it'\\''s here'");
  expect(shellWord("it's here", "win32")).toBe("'it''s here'");
  expect(gitAccessCommand("https://host/a b.git", "linux")).toBe(
    "git ls-remote 'https://host/a b.git'",
  );
});
