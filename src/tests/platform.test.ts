import { beforeEach, expect, test, vi } from "vitest";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import {
  fileExecutable,
  assertPackagePaths,
  installedApplication,
  directoryLinkType,
  environmentValue,
  findExecutable,
  bashShell,
  localPath,
  pathsFor,
  privatePermissions,
  protectPrivate,
  stopProcessTree,
} from "../platform.js";
import { adapters } from "../harnesses/registry.js";
import { isInside } from "../shared/files.js";
import { posixQuote, powershellQuote } from "../shared/shell.js";
import { displayPath } from "../ui/output.js";
import { testRuntime } from "./runtime.js";
import { POSIX_MODE } from "../shared/constants.js";

const fakes = vi.hoisted(() => ({
  execute: vi.fn(),
  stat: vi.fn(),
  access: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  ...fakes,
}));

vi.mock("node:child_process", async () => ({
  execFile: Object.assign(vi.fn(), { [promisify.custom]: fakes.execute }),
  spawn: vi.fn(() => ({ on: vi.fn(), kill: vi.fn() })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  fakes.execute.mockResolvedValue({ stdout: "true\n", stderr: "" });
  fakes.stat.mockRejectedValue(
    Object.assign(new Error("missing"), { code: "ENOENT" }),
  );

  fakes.access.mockResolvedValue(undefined);
  fakes.readFile.mockRejectedValue(
    Object.assign(new Error("missing"), { code: "ENOENT" }),
  );

  fakes.writeFile.mockResolvedValue(undefined);
});

const windows = testRuntime("C:\\Users\\Alice", {
  cwd: "C:\\work",
  platform: "win32",
  env: { Path: "C:\\Tools;C:\\Other", PATHEXT: ".EXE;.CMD" },
});

const linux = testRuntime("/home/alice", {
  cwd: "/work",
  platform: "linux",
  env: { PATH: "/usr/bin:/opt/bin" },
});

test("Windows executable lookup honors case-insensitive PATH and PATHEXT without reading the process", async () => {
  fakes.stat.mockImplementation(async (path: string) => {
    if (path === "C:\\Other\\codex.cmd") {
      return { isFile: () => true };
    }

    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  });

  expect(await findExecutable("codex", windows)).toBe("C:\\Other\\codex.cmd");
  expect(environmentValue(windows, "PATH")).toBe(windows.env.Path);
  expect(fakes.access).toHaveBeenCalledWith(
    "C:\\Other\\codex.cmd",
    expect.any(Number),
  );
});

test("POSIX executable lookup requires execute access and an explicit PATH", async () => {
  fakes.stat.mockResolvedValue({ isFile: () => true });
  expect(await findExecutable("claude", linux)).toBe("/usr/bin/claude");
  expect(fakes.access).toHaveBeenCalledWith("/usr/bin/claude", 1);
  fakes.access.mockRejectedValue(
    Object.assign(new Error("denied"), { code: "EACCES" }),
  );

  expect(await findExecutable("claude", linux)).toBe(null);
  expect(await findExecutable("claude", { ...linux, env: {} })).toBe(null);
});

test.for(["linux", "darwin"] as const)(
  "%s uses POSIX shell words and directory symlinks",
  (platform) => {
    expect(posixQuote("it's $safe")).toBe("'it'\\''s $safe'");
    expect(directoryLinkType(platform)).toBe("dir");
  },
);

test("PowerShell quoting keeps typographic quotes inside the word", () => {
  expect(powershellQuote("it’s")).toBe("'it’’s'");
  expect(directoryLinkType("win32")).toBe("junction");
});

test("Hook shells are explicit on all platforms", async () => {
  expect(await bashShell(linux)).toEqual({ command: "/bin/sh", args: ["-c"] });
  fakes.stat.mockResolvedValue({ isFile: () => true });
  expect((await bashShell(windows)).command).toBe("C:\\Tools\\bash.exe");
  fakes.stat.mockRejectedValue(
    Object.assign(new Error("missing"), { code: "ENOENT" }),
  );

  await expect(bashShell(windows)).rejects.toThrow(
    /Bash, which isn't installed/,
  );
});

test("Windows credentials get a user-only ACL on write and no per-read PowerShell check", async () => {
  expect(privatePermissions(POSIX_MODE.regularFile, "win32")).toBe(true);

  await protectPrivate("C:\\Alice's files", windows);
  const args = fakes.execute.mock.calls.at(-1)![1] as string[];
  const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
  expect(script).toContain("SetAccessRuleProtection($true,$false)");
  expect(script).toContain("SetOwner($sid)");
  expect(script).toContain("C:\\Alice''s files");
  expect(script).toContain("Set-Acl");
});

test("Windows PowerShell doesn't inherit PowerShell 7's module path", async () => {
  await protectPrivate("C:\\private", {
    ...windows,
    env: {
      ...windows.env,
      PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
      psmodulepath: "C:\\other",
    },
  });

  const options = fakes.execute.mock.calls.at(-1)![2] as {
    env: Record<string, string>;
  };

  expect(options.env).toEqual(windows.env);
});

test.for(["linux", "darwin"] as const)(
  "%s credential checks enforce private mode bits",
  async (platform) => {
    expect(privatePermissions(0o600, platform)).toBe(true);
    expect(privatePermissions(POSIX_MODE.regularFile, platform)).toBe(false);

    await protectPrivate("/private", { ...linux, platform });
    expect(fakes.execute).not.toHaveBeenCalled();
  },
);

test("Windows process cleanup includes descendants", () => {
  const child = { pid: 42, kill: vi.fn() } as never;
  stopProcessTree(child, windows);
  expect(spawn).toHaveBeenCalledWith(
    "taskkill.exe",
    ["/pid", "42", "/T", "/F"],
    expect.anything(),
  );
});

test("Windows executable flags come from what BarnDog wrote, else a #! line", async () => {
  expect(
    await fileExecutable(
      "C:\\pkg\\lib.sh",
      POSIX_MODE.regularFile,
      windows,
      true,
    ),
  ).toBe(true);

  fakes.readFile.mockResolvedValue(Buffer.from("#!/bin/sh\n"));
  expect(
    await fileExecutable("C:\\pkg\\hook.sh", POSIX_MODE.regularFile, windows),
  ).toBe(true);

  expect(
    await fileExecutable(
      "C:\\pkg\\hook.sh",
      POSIX_MODE.regularFile,
      windows,
      false,
    ),
  ).toBe(false);

  fakes.readFile.mockResolvedValue(Buffer.from("echo hi\n"));
  expect(
    await fileExecutable(
      "C:\\pkg\\notes.sh",
      POSIX_MODE.executableFile,
      windows,
    ),
  ).toBe(false);

  expect(
    await fileExecutable(
      "/pkg/script",
      POSIX_MODE.executableFile,
      linux,
      false,
    ),
  ).toBe(true);
});

test.for([
  "C:/escape",
  "file:secret",
  "CON.txt",
  "dir/NUL",
  "trailing.",
  "trailing ",
  "bad?.md",
])("rejects unsafe Windows package path %s", (path) => {
  expect(() => assertPackagePaths([{ path }], "win32")).toThrow(
    /Windows can't store/,
  );

  expect(() => assertPackagePaths([{ path }], "linux")).not.toThrow();
});

test("Windows containment handles drive letters, UNC paths, separators and case", () => {
  const paths = pathsFor("win32");
  expect(
    isInside("C:\\Users\\Alice", "c:/users/alice/skills/review", paths),
  ).toBe(true);

  expect(isInside("C:\\Users\\Alice", "C:\\Users\\Alicee\\review", paths)).toBe(
    false,
  );

  expect(isInside("C:\\Users\\Alice", "D:\\Users\\Alice\\review", paths)).toBe(
    false,
  );

  expect(
    isInside(
      "\\\\server\\share\\root",
      "\\\\server\\share\\root\\skill",
      paths,
    ),
  ).toBe(true);

  expect(
    isInside("\\\\server\\share\\root", "\\\\other\\share\\root", paths),
  ).toBe(false);

  expect(displayPath("c:/users/alice/skills/review", windows)).toBe(
    "~\\skills\\review",
  );
});

test("desktop detection has installation evidence for every supported OS", async () => {
  const app = { name: "Cursor" };
  const installed = (path: string) =>
    fakes.stat.mockImplementation(async (probe: string) => {
      if (probe === path) {
        return {};
      }

      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

  installed("/Applications/Cursor.app/Contents/MacOS");
  expect(
    await installedApplication(app, { ...linux, platform: "darwin" }),
  ).toBe("/Applications/Cursor.app");

  installed("/home/alice/.local/share/applications/cursor.desktop");
  expect(await installedApplication(app, linux)).toBe(
    "/home/alice/.local/share/applications/cursor.desktop",
  );

  installed("C:\\Users\\Alice\\AppData\\Local\\Programs\\Cursor\\Cursor.exe");
  expect(
    await installedApplication(app, {
      ...windows,
      env: { LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local" },
    }),
  ).toBe("C:\\Users\\Alice\\AppData\\Local\\Programs\\Cursor\\Cursor.exe");

  expect(await installedApplication(app, { ...windows, env: {} })).toBe(null);
});

test("OpenCode Desktop is found where its installers put it", async () => {
  const app = adapters.opencode.desktopApp;
  const installed = (path: string) =>
    fakes.stat.mockImplementation(async (probe: string) => {
      if (probe === path) {
        return {};
      }

      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

  installed("/Applications/OpenCode.app/Contents/MacOS");
  expect(
    await installedApplication(app, { ...linux, platform: "darwin" }),
  ).toBe("/Applications/OpenCode.app");

  installed("/usr/share/applications/ai.opencode.desktop.desktop");
  expect(await installedApplication(app, linux)).toBe(
    "/usr/share/applications/ai.opencode.desktop.desktop",
  );

  const exe =
    "C:\\Users\\Alice\\AppData\\Local\\Programs\\@opencode-aidesktop\\OpenCode.exe";

  installed(exe);
  expect(
    await installedApplication(app, {
      ...windows,
      env: { LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local" },
    }),
  ).toBe(exe);
});

test("Windows path conversion refuses hidden drive cwd and case aliases before writing", () => {
  expect(localPath("skills/review", windows)).toBe("C:\\work\\skills\\review");
  expect(localPath("D:\\assets", windows)).toBe("D:\\assets");
  expect(() => localPath("D:assets", windows)).toThrow(
    /current folder of drive D:/,
  );

  expect(() =>
    assertPackagePaths([{ path: "Readme.md" }, { path: "README.md" }], "win32"),
  ).toThrow(/differ only in case/);

  expect(() =>
    assertPackagePaths([{ path: "Docs" }, { path: "docs/readme.md" }], "win32"),
  ).toThrow(/inside a folder that differs only in case/);
});
