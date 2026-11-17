import { describe, expect, test } from "vitest";
import { changeSchema } from "@barndog-ai/api-contract";
import { renderCollaboration } from "../ui/collaboration.js";
import { sample } from "./sample.js";

const COMMIT = "a".repeat(40);
const PR_URL = "https://example.test/pr/1";

describe("push output", () => {
  const pushes: {
    name: string;
    result: Record<string, unknown>;
    lines: string[];
  }[] = [
    {
      name: "published shows the commit",
      result: { branch: "review", commit: COMMIT, published: true },
      lines: ["Pushed to review", COMMIT],
    },
    {
      name: "published ignores a pull request URL",
      result: {
        branch: "review",
        commit: COMMIT,
        published: true,
        url: PR_URL,
        opened: true,
      },
      lines: ["Pushed to review", COMMIT],
    },
    {
      name: "opened pull request shows its URL",
      result: {
        branch: "review",
        commit: COMMIT,
        published: false,
        opened: true,
        url: PR_URL,
      },
      lines: ["Pushed review", `Pull request: ${PR_URL}`],
    },
    {
      name: "unopened pull request URL asks you to open it",
      result: {
        branch: "review",
        commit: COMMIT,
        published: false,
        opened: false,
        url: PR_URL,
      },
      lines: ["Pushed review", `Open the pull request: ${PR_URL}`],
    },
    {
      name: "no URL points to the Git host",
      result: { branch: "review", commit: COMMIT, published: false },
      lines: [
        "Pushed review",
        "Open a pull request from this branch on your Git host.",
      ],
    },
  ];

  test.each(pushes)("$name", ({ result, lines }) => {
    expect(renderCollaboration(result)).toEqual(lines);
  });
});

describe("diff rows", () => {
  const modes: [unknown, unknown, string][] = [
    [true, false, "modified  script.sh  executable: true → false"],
    [false, true, "modified  script.sh  executable: false → true"],
    [null, true, "modified  script.sh  executable"],
    [undefined, true, "modified  script.sh  executable"],
    [null, false, "modified  script.sh"],
    [true, true, "modified  script.sh"],
    [false, false, "modified  script.sh"],
    [true, null, "modified  script.sh"],
    [true, undefined, "modified  script.sh"],
    [undefined, undefined, "modified  script.sh"],
  ];

  test.each(modes)(
    "mode change %s → %s is shown as %j",
    (oldExecutable, newExecutable, line) => {
      expect(
        renderCollaboration([
          {
            kind: "modified",
            path: "script.sh",
            patch: "@@ diff",
            oldExecutable,
            newExecutable,
          },
        ]),
      ).toEqual([line, "@@ diff"]);
    },
  );

  test("binary files are marked", () => {
    expect(
      renderCollaboration([
        { kind: "added", path: "logo.png", patch: "", binary: true },
      ]),
    ).toEqual(["added  logo.png (binary)"]);
  });

  test("an empty diff says there are no changes", () => {
    expect(renderCollaboration([])).toEqual(["No changes."]);
  });
});

describe("working status", () => {
  const status = {
    root: "/copy",
    name: "review",
    baseVersion: null,
    proposal: null,
    external: null,
    review: null,
    pending: false,
    conflicts: [],
    changes: [],
  };

  test("a new package with nothing pending says there are no changes", () => {
    expect(renderCollaboration(status)).toEqual([
      "review  /copy",
      "Base: new package",
      "No changes.",
    ]);
  });

  test("a published base is shown as its version", () => {
    expect(renderCollaboration({ ...status, baseVersion: 3 })).toEqual([
      "review  /copy",
      "Base: v3",
      "No changes.",
    ]);
  });

  test("a base commit wins over the version and is shortened", () => {
    expect(
      renderCollaboration({
        ...status,
        baseVersion: 3,
        baseCommit: "abcdef1234567",
      }),
    ).toEqual(["review  /copy", "Base: abcdef1", "No changes."]);
  });

  test("a review branch with a URL, a proposal and a pull request", () => {
    expect(
      renderCollaboration({
        ...status,
        baseVersion: 1,
        review: { branch: "review/1", url: PR_URL },
        proposal: { id: "proposal-1", revision: 2 },
        external: { pull: { number: 4, head: "head-sha" } },
      }),
    ).toEqual([
      "review  /copy",
      "Base: v1",
      `Review branch: review/1  ${PR_URL}`,
      "Suggested Change: proposal-1  revision 2",
      "GitHub PR #4  head-sha",
      "No changes.",
    ]);
  });

  test("a review branch without a URL shows only the branch", () => {
    expect(
      renderCollaboration({
        ...status,
        review: { branch: "review/1", url: null },
      }),
    ).toEqual([
      "review  /copy",
      "Base: new package",
      "Review branch: review/1",
      "No changes.",
    ]);
  });

  test("a pending submission and conflicts tell you what to do", () => {
    expect(
      renderCollaboration({
        ...status,
        pending: true,
        conflicts: ["SKILL.md", "notes.md"],
      }),
    ).toEqual([
      "review  /copy",
      "Base: new package",
      "Submission awaiting confirmation; retry barndog push.",
      "Conflict: SKILL.md",
      "Conflict: notes.md",
      "No changes.",
    ]);
  });

  test("changes are listed without their patch lines", () => {
    expect(
      renderCollaboration({
        ...status,
        changes: [
          {
            kind: "modified",
            path: "SKILL.md",
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
        ],
      }),
    ).toEqual(["review  /copy", "Base: new package", "modified  SKILL.md"]);
  });
});

describe("package files", () => {
  test("text files show their content and binary files are labelled", () => {
    expect(
      renderCollaboration({
        files: [
          {
            path: "run.sh",
            content: Buffer.from("echo hi").toString("base64"),
            executable: true,
          },
          { path: "logo", content: Buffer.from([0, 1]).toString("base64") },
        ],
      }),
    ).toEqual(["run.sh (executable)", "echo hi", "logo", "Binary file"]);
  });

  test("no files render nothing", () => {
    expect(renderCollaboration({ files: false })).toEqual([]);
  });
});

describe("working copy results", () => {
  test("a bare root", () => {
    expect(renderCollaboration({ root: "/new" })).toEqual([
      "Working copy: /new",
    ]);
  });

  test("a commit is shortened and conflicts say how to resolve them", () => {
    expect(
      renderCollaboration({
        root: "/new",
        commit: "abcdef123456",
        conflicts: ["file"],
      }),
    ).toEqual([
      "Working copy: /new",
      "Base: abcdef1",
      "Conflict: file; edit and run barndog resolve <path>.",
    ]);
  });

  test("a version is shown when there is no commit", () => {
    expect(renderCollaboration({ root: "/new", version: 5 })).toEqual([
      "Working copy: /new",
      "Base: v5",
    ]);
  });

  test("a resolved file", () => {
    expect(renderCollaboration({ resolved: "file" })).toEqual([
      "Resolved: file",
    ]);
  });

  test("an unchanged package", () => {
    expect(renderCollaboration({ unchanged: true })).toEqual([
      "Package unchanged.",
    ]);
  });
});

describe("lists and unknown values", () => {
  test("proposals and versions each have their own row, others print as JSON", () => {
    expect(
      renderCollaboration([
        7,
        { other: true },
        {
          name: "review",
          status: "open",
          revision: 2,
          id: "p1",
          title: "Fix it",
        },
        {
          number: 1,
          commit: "abc",
          description: "Initial",
          publishedBy: "Alice",
        },
        {
          number: 2,
          commit: "def",
          description: "Second",
          publishedBy: "id",
          publisherName: "Bob",
        },
      ]),
    ).toEqual([
      "7",
      '{\n  "other": true\n}',
      "review  open  revision 2\n  p1  Fix it",
      "v1  abc\n  Initial  published by Alice",
      "v2  def\n  Second  published by Bob",
    ]);
  });

  test("null prints as JSON", () => {
    expect(renderCollaboration(null)).toEqual(["null"]);
  });
});

describe("change details", () => {
  const change = sample(changeSchema);
  const withFiles = {
    path: "SKILL.md",
    content: Buffer.from("hello").toString("base64"),
  };

  function detailLines(overrides: Record<string, unknown>) {
    return renderCollaboration(
      { ...change, files: [withFiles], ...overrides },
      { details: true },
    );
  }

  test("the author is shown by name when names are known", () => {
    expect(detailLines({ names: { [change.authorId]: "Alice" } })).toContain(
      "Author: Alice",
    );
  });

  test("the author is shown by id when names are absent", () => {
    expect(detailLines({ names: undefined })).toContain(
      `Author: ${change.authorId}`,
    );
  });

  test("the author is shown by id when names are malformed", () => {
    expect(detailLines({ names: false })).toContain(
      `Author: ${change.authorId}`,
    );
  });

  test("a change without a base version is a new package", () => {
    expect(detailLines({ baseVersionId: null })).toContain("Base: new package");
  });

  test("a base version without a number shows its id", () => {
    expect(detailLines({ baseVersionId: change.baseVersionId })).toContain(
      `Base: ${change.baseVersionId}`,
    );
  });

  test("a base version number is preferred over its id", () => {
    expect(
      detailLines({
        baseVersionId: change.baseVersionId,
        baseVersionNumber: 4,
      }),
    ).toContain("Base: v4");
  });

  test("files follow the details, after a blank line", () => {
    const lines = detailLines({});

    expect(lines.slice(-3)).toEqual(["", "SKILL.md", "hello"]);
  });

  for (const [status, title] of [
    ["open", "Suggested Change"],
    ["merged", "Published"],
  ] as const) {
    test(`without details only the title lines of a ${status} change are shown`, () => {
      const lines = renderCollaboration({
        ...change,
        status,
        files: [withFiles],
      });

      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(`${title}  ${change.id}`);
    });
  }
});
