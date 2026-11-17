import { expect, test, vi, type TestContext } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDistinctNames,
  finish,
  notFound,
  onlyChosen,
  updateMode,
} from "../ui/add-asset.js";
import type { AddContext } from "../ui/add-asset.js";
import { addSkills } from "../ui/add-skills.js";
import { synchronize } from "../features/environment/sync.js";
import type { RemoteRepo } from "../features/imports/remote.js";
import { GIT_MODE } from "../features/workspace/snapshot.js";
import { readSettings, saveSettings } from "../config/settings.js";
import { CliError } from "../errors.js";
import { testRuntime } from "./runtime.js";

vi.mock("../features/environment/sync.js", () => ({ synchronize: vi.fn() }));

function context(home = "/unused"): AddContext {
  return {
    runtime: testRuntime(home),
    interactive: true,
    write: vi.fn(),
    prompts: {
      chooseOne: vi.fn(),
      chooseMany: vi.fn(),
      text: vi.fn(),
      yes: vi.fn(),
      paste: vi.fn(),
    },
  };
}

/** The error a call throws, so its class, message and hint can be checked. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }

  return undefined;
}

test("--updates decides how an import stays up to date, without asking", async () => {
  const ctx = context();

  expect(await updateMode({ updates: "auto" }, ctx)).toBe("auto");
  expect(ctx.prompts.chooseOne).not.toHaveBeenCalled();
});

test("without --updates and without a terminal, imports update when asked", async () => {
  const ctx = context();
  ctx.interactive = false;

  expect(await updateMode({}, ctx)).toBe("manual");
  expect(ctx.prompts.chooseOne).not.toHaveBeenCalled();
});

test("in a terminal the update choice is asked, defaulting to updating when asked", async () => {
  const ctx = context();
  vi.mocked(ctx.prompts.chooseOne).mockResolvedValue("fork");

  expect(await updateMode({}, ctx)).toBe("fork");

  const [message, choices, fallback] = vi.mocked(ctx.prompts.chooseOne).mock
    .lastCall!;

  expect(message).toBe("How should it stay up to date?");
  expect(choices.map((choice) => choice.value)).toEqual([
    "manual",
    "fork",
    "auto",
  ]);

  expect(fallback).toBe("manual");
});

function repo(path: string, ref: string | null): RemoteRepo {
  return {
    url: "https://example.test/repo",
    ref,
    commit: "a".repeat(40),
    path,
    snapshot: {
      entries: [
        {
          path: "skills/review/SKILL.md",
          hash: "a".repeat(40),
          mode: GIT_MODE.file,
        },
        {
          path: "skills/review/docs/notes.txt",
          hash: "b".repeat(40),
          mode: GIT_MODE.file,
        },
      ],
      readBlobs: async () => new Map(),
    },
    blobs: new Map(),
  };
}

for (const [situation, path, ref, message, hint] of [
  [
    "a folder the repo doesn't have",
    "missing",
    null,
    "Can't find missing in https://example.test/repo.",
    "barndog skills add https://example.test/repo",
  ],
  [
    "a folder the branch doesn't have",
    "missing",
    "main",
    "Can't find missing in https://example.test/repo at main.",
    "barndog skills add https://example.test/repo",
  ],
  [
    "a folder with no Skill in it",
    "skills/review/docs",
    null,
    "No valid Skill found in skills/review/docs or the folders below it. A Skill is a folder with a SKILL.md. BarnDog only looks where the link points, not in the rest of the repo.",
    "barndog skills add https://example.test/repo",
  ],
] as const) {
  test(`a link to ${situation} says where it looked, with a fix`, () => {
    const remote = repo(path, ref);

    expect(notFound(remote, remote.url, "Skill")).toMatchObject({
      message,
      hint,
    });
  });
}

test("a repository with no Hook anywhere says what a Hook is", () => {
  const error = notFound(repo("", null), "https://example.test/repo", "Hook");

  expect(error).toBeInstanceOf(CliError);
  expect(error.message).toBe(
    "No valid Hook found in https://example.test/repo. A Hook is a folder with hook.yaml, hook settings, or scripts.",
  );
});

const candidates = [
  { name: "review", root: "skills/review" },
  { name: "notes", root: "skills/notes" },
];

test("--only picks candidates by name or by folder, in the source's order", () => {
  expect(
    onlyChosen(candidates, ["skills/notes", "review"], {
      url: "https://example.test/repo",
      kind: "skill",
    }),
  ).toEqual(candidates);
});

test("--only with an unknown name fails and lists the names the source has", () => {
  const error = thrown(() =>
    onlyChosen(candidates, ["review", "notse"], {
      url: "https://example.test/repo",
      kind: "skill",
    }),
  );

  expect(error).toBeInstanceOf(CliError);
  expect(error).toMatchObject({
    message:
      "https://example.test/repo has no Skill named notse. It has review, notes.",
    hint: "barndog skills add https://example.test/repo --only <name>",
  });
});

test("two chosen assets with one name are refused, naming both folders and how to pick one", () => {
  const error = thrown(() =>
    assertDistinctNames(
      [
        { name: "lint", root: "" },
        { name: "lint", root: "hooks/lint" },
      ],
      { url: "https://example.test/repo", kind: "hook" },
    ),
  );

  expect(error).toMatchObject({
    message:
      "lint is in more than one folder: repo root, hooks/lint. Choose one.",
    hint: "barndog hooks add https://example.test/repo --only hooks/lint",
  });
});

async function skillsFolder(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "barndog-add-skills-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  await saveSettings({ harnesses: [] }, home);
  const folder = join(home, "source");
  for (const name of ["review", "notes"]) {
    await mkdir(join(folder, name), { recursive: true });
    await writeFile(
      join(folder, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name}\n---\nBody\n`,
    );
  }

  return { home, folder };
}

test("skills add --only with a mistyped name adds nothing", async (t) => {
  const { home, folder } = await skillsFolder(t);
  const ctx = context(home);

  const error: unknown = await addSkills(
    folder,
    { only: ["reveiw"], copy: true },
    ctx,
  ).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(CliError);
  expect(error).toHaveProperty(
    "message",
    expect.stringMatching(
      /has no Skill named reveiw\. It has (notes, review|review, notes)\.$/,
    ),
  );

  expect((await readSettings(home))?.localWorkspace).toBeUndefined();
});

test("after an import, invalid assets are reported and other sync output is left out", async () => {
  const ctx = context();
  vi.mocked(synchronize).mockResolvedValue([
    { type: "invalid", name: "broken", kind: "skill", reason: "No SKILL.md" },
    { type: "notice", message: "ignored" },
  ]);

  await finish(ctx);

  expect(vi.mocked(ctx.write).mock.calls).toEqual([["! broken: No SKILL.md"]]);
});
