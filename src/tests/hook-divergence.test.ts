import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { expect, test } from "vitest";
import { folderDivergence } from "../features/hooks/divergence.js";

/** A tool section running `scripts`; an empty list means an inline command. */
const section = (scripts: string[]) => ({
  compatibility: "supported",
  scripts,
  requirements: { commands: [] },
  events: {
    Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
  },
});

const cases: [string, Record<string, string[]>, string | null][] = [
  ["one tool", { claude: ["a.sh"] }, null],
  [
    "every tool runs the same scripts, in any order",
    { claude: ["a.sh", "b.sh"], codex: ["b.sh", "a.sh", "a.sh"] },
    null,
  ],
  [
    "an inline command has no scripts to keep in step",
    { claude: ["a.sh"], codex: [], cursor: ["a.sh"] },
    null,
  ],
  ["only inline commands", { claude: [], codex: [] }, null],
  [
    "two tools with their own scripts",
    { claude: ["claude.sh"], cursor: ["cursor.sh"] },
    "Claude Code and Cursor each run their own scripts in this Hook. When you change one, check whether the other needs the same change.",
  ],
  [
    "three tools with their own scripts",
    { claude: ["a.sh"], codex: ["b.sh"], cursor: ["c.sh"] },
    "Claude Code, Codex and Cursor each run their own scripts in this Hook. When you change one, check whether the others need the same change.",
  ],
  [
    "one tool differs from two that share",
    { claude: ["check.sh"], codex: ["check-codex.sh"], cursor: ["check.sh"] },
    "Codex runs different scripts from Claude Code and Cursor in this Hook. When you change one set, check whether the other needs the same change.",
  ],
];

for (const [name, scripts, expected] of cases) {
  test(`divergence: ${name}`, async (t) => {
    const folder = await mkdtemp(join(tmpdir(), "barndog-divergence-"));
    t.onTestFinished(() => rm(folder, { recursive: true, force: true }));
    await writeFile(
      join(folder, "hook.yaml"),
      stringify({
        name: "guard",
        description: "Guards",
        implementations: Object.fromEntries(
          Object.entries(scripts).map(([tool, list]) => [tool, section(list)]),
        ),
      }),
    );

    expect(await folderDivergence(folder)).toBe(expected);
  });
}
