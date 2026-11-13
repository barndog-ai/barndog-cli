import { describe, expect, test } from "vitest";
import type { Command } from "commander";

import {
  cloudOnlyCommands,
  commandNeeds,
  reviewCommands,
} from "../commands/availability.js";
import { friendlyMessage } from "../errors.js";
import { SESSION_TOKEN } from "../features/auth/credentials.js";
import { hasConflictMarkers } from "../features/collaboration/workspace.js";
import { withoutCopyNumber } from "../features/environment/names.js";
import {
  checkRepositoryUrl,
  gitReason,
  parseLsRemote,
  parseRemoteHead,
  UNKNOWN_IDENTITY,
} from "../features/git-workspace/git.js";
import { firstUrl } from "../features/git-workspace/publish.js";
import {
  plainCommand,
  scriptLike,
  scriptPath,
} from "../features/imports/discover.js";
import { expandHome, looksLocal } from "../features/imports/folder.js";
import {
  embeddedVariable,
  envName,
  looksSecret,
  variableName,
} from "../features/imports/mcp.js";
import { parseLocation } from "../features/imports/remote.js";
import { hookSettingsOwner } from "../harnesses/registry.js";
import {
  CONSTANT_CASE,
  GIT_OBJECT_ID,
  NAME,
  POSITIVE_INTEGER,
  setYamlName,
  slugify,
  splitFrontMatter,
  splitOrigin,
  UUID_V4,
} from "../shared/patterns.js";
import { createProgram } from "../program.js";
import { safe } from "../ui/collaboration.js";

const sha1 = "3f786850e387550fdab836ed7e6dc881de23001b";
const sha256 = `${sha1}${"0".repeat(24)}`;

describe("shared identifier patterns", () => {
  test.each([
    ["729b9d5a-4a8c-4aa7-9b8d-975a55ac373e", true],
    ["729B9D5A-4A8C-4AA7-9B8D-975A55AC373E", true],
    ["729b9d5a-4a8c-1aa7-9b8d-975a55ac373e", false], // version 1
    ["729b9d5a-4a8c-4aa7-cb8d-975a55ac373e", false], // wrong variant
    ["729b9d5a4a8c4aa79b8d975a55ac373e", false],
    [" 729b9d5a-4a8c-4aa7-9b8d-975a55ac373e", false],
    ["", false],
  ])("UUID_V4 %j → %s", (value, expected) => {
    expect(UUID_V4.test(value)).toBe(expected);
  });

  test.each([
    [sha1, true],
    [sha1.toUpperCase(), false],
    [sha1.slice(1), false],
    [sha256, false],
    [`${sha1}\n`, false],
  ])("GIT_OBJECT_ID %j → %s", (value, expected) => {
    expect(GIT_OBJECT_ID.test(value)).toBe(expected);
  });

  test.each([
    ["code-review", true],
    ["team2", true],
    ["a", true],
    ["-a", false],
    ["a-", false],
    ["a--b", false],
    ["Code", false],
    ["a_b", false],
    ["", false],
  ])("NAME %j → %s", (value, expected) => {
    expect(NAME.test(value)).toBe(expected);
  });

  test.each([
    ["1", true],
    ["20", true],
    ["0", false],
    ["01", false],
    ["1.5", false],
    ["-1", false],
    ["", false],
  ])("POSITIVE_INTEGER %j → %s", (value, expected) => {
    expect(POSITIVE_INTEGER.test(value)).toBe(expected);
  });

  test.each([
    ["API_KEY", true],
    ["KNOWLEDGE_NOT_FOUND", true],
    ["A", true],
    ["Api_key", false],
    ["_API", false],
    ["1API", false],
  ])("CONSTANT_CASE %j → %s", (value, expected) => {
    expect(CONSTANT_CASE.test(value)).toBe(expected);
  });

  test.each([
    ["a".repeat(43), true],
    ["aZ09_-".repeat(7) + "a", true],
    ["a".repeat(42), false],
    ["a".repeat(44), false],
    ["a".repeat(42) + "+", false],
  ])("SESSION_TOKEN %j → %s", (value, expected) => {
    expect(SESSION_TOKEN.test(value)).toBe(expected);
  });

  test.each([
    ["Team A/Review!", "team-a-review"],
    ["my--hook", "my-hook"],
    ["--a--", "a"],
    ["dev-1F2e", "dev-1f2e"],
    ["!!!", ""],
    ["", ""],
  ])("slugify %j → %j", (value, expected) => {
    expect(slugify(value)).toBe(expected);
    if (expected) expect(NAME.test(expected)).toBe(true);
  });

  test.each([
    ["org", { type: "org" }],
    ["team/review", { type: "team", value: "review" }],
    ["team:review", { type: "team", value: "review" }],
    ["repo/a/b", { type: "repo", value: "a/b" }],
    ["dev/", { type: "dev", value: "" }],
  ])("splitOrigin %j", (value, expected) => {
    expect(splitOrigin(value)).toEqual(expected);
  });
});

describe("front matter and the name line", () => {
  test.each([
    [
      "---\nname: a\n---\nBody\n",
      { open: "---\n", yaml: "name: a", close: "\n---\n", body: "Body\n" },
    ],
    [
      "﻿---\r\nname: a\r\n---\r\nBody",
      {
        open: "﻿---\r\n",
        yaml: "name: a",
        close: "\r\n---\r\n",
        body: "Body",
      },
    ],
    [
      "---\nname: a\n---",
      { open: "---\n", yaml: "name: a", close: "\n---", body: "" },
    ],
    [
      "---\na: 1\n---\nb\n---\n",
      { open: "---\n", yaml: "a: 1", close: "\n---\n", body: "b\n---\n" },
    ],
  ])("splitFrontMatter %j", (text, expected) => {
    expect(splitFrontMatter(text)).toEqual(expected);
  });

  test.each([
    "name: a\n",
    "---\nname: a\n",
    "text\n---\nname: a\n---\n",
    "--- \nname: a\n---\n",
  ])("splitFrontMatter without front matter %j", (text) => {
    expect(splitFrontMatter(text)).toBeNull();
  });

  test.each([
    ["name: old\ndescription: x", "name: new\ndescription: x"],
    ["description: x\nname : old", "description: x\nname: new"],
    ["description: x", "name: new\ndescription: x"],
    ["meta:\n  name: inner", "name: new\nmeta:\n  name: inner"],
    ["name: a\nname: b", "name: new\nname: b"],
    ["names: list\nname: old", "names: list\nname: new"],
  ])("setYamlName %j", (yaml, expected) => {
    expect(setYamlName(yaml, "new")).toBe(expected);
  });

  test("setYamlName writes replacement patterns literally", () => {
    expect(setYamlName("name: old", "$&")).toBe("name: $&");
  });
});

describe("Git output", () => {
  test.each([
    [
      `ref: refs/heads/main\tHEAD\n${sha1}\tHEAD\n`,
      { branch: "main", commit: sha1 },
    ],
    [
      `ref: refs/heads/release/1.0\tHEAD\n${sha1}\tHEAD`,
      { branch: "release/1.0", commit: sha1 },
    ],
    ["", null],
  ])("parseRemoteHead %j", (output, expected) => {
    expect(parseRemoteHead(output, "url")).toEqual(expected);
  });

  test("parseRemoteHead refuses SHA-256 repositories", () => {
    expect(() =>
      parseRemoteHead(`ref: refs/heads/main\tHEAD\n${sha256}\tHEAD\n`, "url"),
    ).toThrow(/SHA-256/);
  });

  test.each([
    [`${sha1}\tHEAD\n`],
    ["ref: refs/heads/main\tHEAD\n"],
    [`ref: refs/tags/v1\tHEAD\n${sha1}\tHEAD\n`],
  ])("parseRemoteHead without a default branch %j", (output) => {
    expect(() => parseRemoteHead(output, "the-url")).toThrow(
      "Can't find the default branch of the-url.",
    );
  });

  test.each([
    ["", []],
    [`${sha1}\trefs/heads/main\n`, [{ commit: sha1, ref: "refs/heads/main" }]],
    [
      `${sha1}\trefs/heads/a\n${sha1}\trefs/tags/v1\n`,
      [
        { commit: sha1, ref: "refs/heads/a" },
        { commit: sha1, ref: "refs/tags/v1" },
      ],
    ],
    ["warning: something\n", []],
  ])("parseLsRemote %j", (output, expected) => {
    expect(parseLsRemote(output)).toEqual(expected);
  });

  test.each([
    [
      "hint: try again\nfatal: repository 'x' not found\n",
      "repository 'x' not found",
    ],
    ["remote: Not Found\nfatal: unable to access", "Not Found"],
    ["error:   pathspec 'x' did not match", "pathspec 'x' did not match"],
    ["something odd\n  last line  \n", "last line"],
    ["", ""],
  ])("gitReason %j → %j", (stderr, expected) => {
    expect(gitReason(stderr)).toBe(expected);
  });

  test.each([
    ["*** Please tell me who you are.\n\nRun\n", true],
    ["Please Tell Me Who You Are", true],
    ["fatal: not a git repository", false],
  ])("UNKNOWN_IDENTITY %j → %s", (stderr, expected) => {
    expect(UNKNOWN_IDENTITY.test(stderr)).toBe(expected);
  });

  test.each([
    [
      "Creating pull request\nhttps://github.com/o/r/pull/1\n",
      "https://github.com/o/r/pull/1",
    ],
    [
      "See http://gitlab.local/o/r/-/merge_requests/2 now",
      "http://gitlab.local/o/r/-/merge_requests/2",
    ],
    ["no link here", undefined],
  ])("firstUrl %j", (text, expected) => {
    expect(firstUrl(text)).toBe(expected);
  });
});

describe("repository URLs", () => {
  test.each([
    "https://github.com/o/r.git",
    "git@github.com:o/r.git",
    "https://user@github.com/o/r.git",
    "  /srv/git/r.git  ",
  ])("checkRepositoryUrl accepts %j", (url) => {
    expect(checkRepositoryUrl(url)).toBe(url.trim());
  });

  test.each([
    ["", /isn't a Git repository URL/],
    ["--upload-pack=x", /isn't a Git repository URL/],
    ["ext::sh -c touch% /tmp/x", /isn't a Git repository URL/],
    ["FD::17", /isn't a Git repository URL/],
    ["https://user:token@github.com/o/r.git", /Remove the password/],
    ["ssh://git:pw@host/r.git", /Remove the password/],
  ])("checkRepositoryUrl refuses %j", (url, message) => {
    expect(() => checkRepositoryUrl(url)).toThrow(message);
  });

  test.each([
    ["anthropics/skills", "https://github.com/anthropics/skills.git", null],
    ["a-b/c.d_e", "https://github.com/a-b/c.d_e.git", null],
    [
      "https://github.com/o/r/tree/main/skills/x",
      "https://github.com/o/r.git",
      "main/skills/x",
    ],
    [
      "https://github.com/o/r.git/blob/feature%2Fx/hook.yaml/",
      "https://github.com/o/r.git",
      "feature/x/hook.yaml",
    ],
    [
      "https://gitlab.com/g/r/-/tree/v1/hooks",
      "https://gitlab.com/g/r.git",
      "v1/hooks",
    ],
    ["https://github.com/o/r.git/", "https://github.com/o/r.git", null],
    ["git@github.com:o/r.git", "git@github.com:o/r.git", null],
    ["-owner/repo", "-owner/repo", "throws"],
    ["o/r/extra", "o/r/extra", null],
  ])("parseLocation %j", (input, url, rest) => {
    if (rest === "throws") {
      expect(() => parseLocation(input)).toThrow();
      return;
    }
    expect(parseLocation(input)).toEqual({ url, rest });
  });

  test.each([
    ["~/skills", "/home/me/skills"],
    ["~", "/home/me"],
    ["~user/skills", "~user/skills"],
    ["a/~/b", "a/~/b"],
  ])("expandHome %j", (path, expected) => {
    expect(expandHome(path, "/home/me")).toBe(expected);
  });

  test.each([
    ["/abs", true],
    [".", true],
    ["..", true],
    ["./x", true],
    ["../x", true],
    ["~", true],
    ["~/x", true],
    ["  ./x", true],
    ["~user", false],
    ["owner/repo", false],
    ["...", false],
    ["https://github.com/o/r", false],
  ])("looksLocal %j → %s", (source, expected) => {
    expect(looksLocal(source)).toBe(expected);
  });
});

describe("harness settings and hook commands", () => {
  test.each([
    [".claude/settings.json", "claude"],
    ["sub/.claude/settings.local.json", "claude"],
    ["plugins/p/hooks/hooks.json", "claude"],
    ["hooks/hooks.json", "claude"],
    [".codex/hooks.json", "codex"],
    [".codex/config.toml", "codex"],
    [".cursor/hooks.json", "cursor"],
    ["hooks/hooks-cursor.json", "cursor"],
    ["my.claude/settings.json", undefined],
    [".claude/settings.jsonc", undefined],
    [".claude/settings.json.bak", undefined],
    ["myhooks/hooks.json", undefined],
    ["config.toml", undefined],
  ])("hookSettingsOwner %j → %s", (path, expected) => {
    expect(hookSettingsOwner(path)).toBe(expected);
  });

  test.each([
    ['"$CLAUDE_PROJECT_DIR/.claude/hooks/check.sh"', ".claude/hooks/check.sh"],
    ["${CLAUDE_PLUGIN_ROOT}/hooks/a.py", "hooks/a.py"],
    ["$(git rev-parse --show-toplevel)/x.sh", "x.sh"],
    ["./run.sh", "run.sh"],
    ["'././run.sh'", "run.sh"],
    ["~/bin/x.sh", "bin/x.sh"],
    ["$lower/x.sh", "$lower/x.sh"],
    ["node", "node"],
    ["", ""],
  ])("scriptPath %j → %j", (token, expected) => {
    expect(scriptPath(token)).toBe(expected);
  });

  test.each([
    ["hooks/check.sh", true],
    ["a.ts", true],
    ["a.mjs", true],
    ["a.py", true],
    ["README.md", false],
    ["sh", false],
    ["a.sh.bak", false],
    ["dir.sh/file", false],
  ])("scriptLike %j → %s", (path, expected) => {
    expect(scriptLike(path)).toBe(expected);
  });

  test.each([
    ["check.py", false, "python3 @@check.py"],
    ["a/b.cjs", false, "node @@a/b.cjs"],
    ["b.mjs", false, "node @@b.mjs"],
    ["b.js", false, "node @@b.js"],
    ["c.rb", false, "ruby @@c.rb"],
    ["d.pl", false, "perl @@d.pl"],
    ["a.sh", false, "@@a.sh"],
    ["a.py", true, "@@a.py"],
    ["Makefile", false, "@@Makefile"],
  ])("plainCommand %j executable=%s", (script, executable, expected) => {
    expect(plainCommand(script, executable)).toBe(expected);
  });
});

describe("MCP import", () => {
  test.each([
    ["${API_KEY}", "API_KEY"],
    ["${env:API_KEY}", "API_KEY"],
    ["$API_KEY", "API_KEY"],
    ["$_x1", "_x1"],
    ["Bearer ${X}", undefined],
    ["${X} ", undefined],
    ["$1X", undefined],
    ["${}", undefined],
    ["${env:}", undefined],
    ["plain", undefined],
  ])("variableName %j → %s", (value, expected) => {
    expect(variableName(value)).toBe(expected);
  });

  test.each([
    ["Bearer ${env:TOKEN}", "TOKEN"],
    ["${A}-${B}", "A"],
    ["Bearer $TOKEN", undefined],
  ])("embeddedVariable %j → %s", (value, expected) => {
    expect(embeddedVariable(value)).toBe(expected);
  });

  test.each([
    ["my-server_x-api", "MY_SERVER_X_API"],
    ["a.b c", "A_B_C"],
    ["ALREADY_OK", "ALREADY_OK"],
  ])("envName %j → %s", (text, expected) => {
    expect(envName(text)).toBe(expected);
  });

  test.each([
    ["--api-key=1", true],
    ["--apikey", true],
    ["API_KEY", true],
    ["--token", true],
    ["client_secret", true],
    ["Password", true],
    ["sk-abc123", true],
    ["--verbose", false],
    ["task-sk-1", false],
    ["-y", false],
  ])("looksSecret %j → %s", (arg, expected) => {
    expect(looksSecret(arg)).toBe(expected);
  });
});

describe("package content", () => {
  test.each([
    ["<<<<<<< local\na\n=======\nb\n>>>>>>> remote\n", true],
    ["before\n=======\nafter", true],
    ["||||||| base", true],
    [">>>>>>>", true],
    ["<<<<<<<< eight", false],
    ["  =======", false],
    ["text =======", false],
    ["=======text", false],
    ["# Title\n======\n", false],
  ])("hasConflictMarkers %j → %s", (text, expected) => {
    expect(hasConflictMarkers(text)).toBe(expected);
  });

  test.each([
    ["review-1a2b-2", "review-1a2b"],
    ["review-10", "review"],
    ["review", undefined],
    ["review-", undefined],
  ])("withoutCopyNumber %j → %s", (folder, expected) => {
    expect(withoutCopyNumber(folder)).toBe(expected);
  });

  test.each([
    ["\x1b[31mred", "\\u001b[31mred"],
    ["tab\tand\nnewline", "tab\tand\nnewline"],
    ["bell\x07", "bell\\u0007"],
    ["c1\x9b", "c1\\u009b"],
  ])("safe %j", (value, expected) => {
    expect(safe(value)).toBe(expected);
  });

  test.each([
    [new Error("KNOWLEDGE_NOT_FOUND"), "Knowledge not found."],
    [
      new Error("MISSING_PACKAGE_MANIFEST: hook.yaml"),
      "This folder has no hook.yaml",
    ],
    [new Error("UNSAFE_PACKAGE_ENTRY: a: b"), "a: b"],
    [new Error("Plain sentence"), "Plain sentence"],
  ])("friendlyMessage %s", (error, expected) => {
    expect(friendlyMessage(error)).toBe(expected);
  });
});

describe("command routing", () => {
  const paths = (command: Command, prefix: string[] = []): string[] =>
    command.commands
      .filter((child) => child.name() !== "help")
      .flatMap((child) => {
        const path = [...prefix, child.name()];
        return [path.join(" "), ...paths(child, path)];
      });

  const commands = paths(createProgram());

  test.each([...cloudOnlyCommands, ...reviewCommands].map((p) => [p]))(
    "%s still matches a real command",
    (pattern) => {
      expect(commands.some((command) => pattern.test(command))).toBe(true);
    },
  );

  test.each([
    ["login", "git", "cloud"],
    ["auth status", "local", "cloud"],
    ["changes", "git", "cloud"],
    ["skills changes list", "local", "cloud"],
    ["hooks promote", "git", "cloud"],
    ["github pulls list", "git", "cloud"],
    ["push", "local", "shared"],
    ["skills pull", "local", "shared"],
    ["mcp versions", "local", "shared"],
    ["push", "git", undefined],
    ["sync", "local", undefined],
    ["skills list", "local", undefined],
    ["peoplex", "git", undefined],
    ["login now", "git", undefined],
  ] as const)("commandNeeds(%j, %s) → %s", (command, mode, expected) => {
    expect(commandNeeds(command, mode)).toBe(expected);
  });
});
