import { describe, expect, test } from "vitest";
import { ApiError } from "@barndog-ai/api-contract";
import {
  hookMetadata,
  packageMetadata,
  validatePackageEntries,
  type PackageEntry,
} from "@barndog-ai/api-contract/package";

import {
  CliError,
  friendlyHint,
  friendlyMessage,
  PackageError,
  packageProblemCodes,
  serverProblemCodes,
} from "../errors.js";
import { serverFetch } from "../features/auth/transport.js";
import { HTTP_STATUS } from "../shared/constants.js";
import { CONSTANT_CASE } from "../shared/patterns.js";

const file = (path: string, text = ""): PackageEntry => ({
  path,
  data: Buffer.from(text),
  executable: false,
});

/** What the contract's package helpers throw, as the CLI receives it. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }

  throw new Error("expected the call to throw");
}

describe("every error code has a friendly message", () => {
  test.each(packageProblemCodes)("package code %s", (code) => {
    for (const error of [
      new PackageError(code),
      new PackageError(code, "a/run.sh"),
    ]) {
      const message = friendlyMessage(error);

      expect(message).not.toContain(code);
      expect(message).not.toContain("undefined");
      expect(CONSTANT_CASE.test(message)).toBe(false);
    }
  });

  test.each(serverProblemCodes)("server code %s", (code) => {
    const error = new ApiError(HTTP_STATUS.conflict, "CONFLICT", code);
    const message = friendlyMessage(error);

    expect(message).not.toContain(code);
    expect(message).toMatch(/\.$/);
    expect(friendlyHint(error)).not.toBe("");
  });
});

describe("package codes from the contract and the server", () => {
  test.each([
    [
      "an unsafe path",
      () => validatePackageEntries([file("../SKILL.md")]),
      "It contains a link or an unsafe file path",
    ],
    [
      "a file and a folder at one path",
      () => validatePackageEntries([file("SKILL.md"), file("a"), file("a/b")]),
      "A file and a folder share the same path",
    ],
    [
      "no SKILL.md",
      () => validatePackageEntries([file("README.md")]),
      "This folder has no SKILL.md",
    ],
    [
      "no hook.yaml",
      () => validatePackageEntries([file("run.sh")], undefined, "hook.yaml"),
      "This folder has no hook.yaml",
    ],
    [
      "SKILL.md without front matter",
      () => packageMetadata([file("SKILL.md", "# Hi")]),
      "SKILL.md needs front matter with a lowercase hyphenated name and a description",
    ],
    [
      "a missing Hook script",
      () =>
        hookMetadata([
          file(
            "hook.yaml",
            [
              "name: audit",
              "description: Audit",
              "implementations:",
              "  claude:",
              "    compatibility: supported",
              "    scripts: [run.sh]",
              "    events:",
              "      PreToolUse:",
              "        - hooks:",
              "            - type: command",

              '              command: "${BARNDOG_HOOK_ROOT}/run.sh"',
            ].join("\n"),
          ),
        ]),
      "hook.yaml declares a script that isn't in the folder: run.sh",
    ],
  ])("%s reads as a sentence", (_, run, expected) => {
    expect(friendlyMessage(thrown(run))).toBe(expected);
  });

  test("the server's package codes read the same way", () => {
    expect(
      friendlyMessage(
        new ApiError(
          HTTP_STATUS.payloadTooLarge,
          "PAYLOAD_TOO_LARGE",
          "PACKAGE_TOO_LARGE",
        ),
      ),
    ).toBe("It's too large to package");
  });

  test("other server codes read as a sentence", () => {
    expect(
      friendlyMessage(
        new ApiError(HTTP_STATUS.notFound, "NOT_FOUND", "KNOWLEDGE_NOT_FOUND"),
      ),
    ).toBe("Knowledge not found.");
  });

  test("a plain message passes through", () => {
    expect(friendlyMessage(new Error("Plain sentence"))).toBe("Plain sentence");
  });

  test("a CliError's text is never read as a code", () => {
    expect(friendlyMessage(new CliError("PACKAGE_TOO_LARGE"))).toBe(
      "PACKAGE_TOO_LARGE",
    );
  });
});

test("an unreachable server is a CliError with a fix", async () => {
  // Port 1 on loopback refuses connections.
  const request = serverFetch(
    "http://127.0.0.1:1",
    undefined,
    false,
  )("http://127.0.0.1:1/v1/health");

  await expect(request).rejects.toBeInstanceOf(CliError);
  await expect(request).rejects.toMatchObject({
    message: expect.stringContaining("Can't reach the BarnDog server"),
    hint: "barndog doctor",
  });
});
