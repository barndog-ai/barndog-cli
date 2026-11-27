import { HTTP_STATUS } from "../shared/constants.js";
import { expect, test, type TestContext } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cloud, packages } from "./cloud.js";
import { testRuntime } from "./runtime.js";
import { localWorkspace } from "../features/workspace/setup.js";
import { readSettings, saveSettings } from "../config/settings.js";
import {
  knowledgeGet,
  knowledgeList,
  knowledgeProblems,
  knowledgeIndexText,
} from "../features/knowledge/index.js";
import { hookCompatibility } from "../features/hooks/compatibility.js";
import { showPackage } from "../features/inventory/show.js";
import { hookBlocked } from "../features/inventory/hook-readiness.js";
import { renderPackageDetails } from "../ui/package-details.js";
import { stripVTControlCharacters } from "node:util";
import type { Harness } from "../harnesses/registry.js";

/** A Cloud workspace with a local folder holding two valid documents and a broken one. */
async function knowledgeFixture(t: TestContext, enabled: boolean) {
  const server = await cloud(t);
  const runtime = testRuntime(server.home);
  const local = await localWorkspace(runtime);
  const settings = (await readSettings(server.home))!;
  await saveSettings(
    { ...settings, localWorkspace: local, knowledge: enabled },
    server.home,
  );

  await writeFile(
    join(local.path, "org/knowledge/local-context.md"),
    "---\ndescription: Local context\naccessMode: always\n---\nLocal content\n",
  );

  await writeFile(
    join(local.path, "org/knowledge/optional.md"),
    "---\ndescription: Optional context\naccessMode: on-demand\n---\nOptional content\n",
  );

  await writeFile(
    join(local.path, "org/knowledge/broken.md"),
    "not front matter",
  );

  return { server, runtime, local };
}

const respondWith = (status: number) => () =>
  Response.json({ message: "server said no" }, { status });

const sharedLookupFailures = {
  "is not found": respondWith(HTTP_STATUS.notFound),
  "fails with a server error": respondWith(HTTP_STATUS.internalServerError),
  "cannot be reached": () => {
    throw new TypeError("fetch failed");
  },
};

for (const [failure, reply] of Object.entries(sharedLookupFailures)) {
  test(`a retained local document is still readable when the shared lookup ${failure}`, async (t) => {
    const { server, runtime } = await knowledgeFixture(t, true);
    server.respond("GET", "/v1/knowledge/local-context", reply);

    expect(await knowledgeGet("local-context", runtime)).toMatchObject({
      version: {
        content: { name: "local-context", markdown: "Local content\n" },
      },
    });
  });

  test(`a missing document is reported as the shared lookup's own failure when the shared lookup ${failure}`, async (t) => {
    const { server, runtime } = await knowledgeFixture(t, true);
    server.respond("GET", "/v1/knowledge/nowhere", reply);

    await expect(knowledgeGet("nowhere", runtime)).rejects.toThrow(
      failure === "cannot be reached" ? "Can't reach" : "server said no",
    );
  });
}

for (const enabled of [false, true]) {
  test(`local knowledge is listed at session start only when "always" and knowledge is enabled (${enabled})`, async (t) => {
    const { runtime } = await knowledgeFixture(t, enabled);

    const all = await knowledgeList(false, runtime);
    expect(
      Object.fromEntries(all.map((doc) => [doc.name, doc.listedAtStart])),
    ).toEqual({
      "release-notes": enabled,
      "local-context": enabled,
      optional: false,
    });

    const always = await knowledgeList(true, runtime);
    expect(always.map((doc) => doc.name)).toEqual([
      "release-notes",
      "local-context",
    ]);
  });
}

test("a local knowledge file without front matter is reported with its reason, not silently dropped", async (t) => {
  const { runtime } = await knowledgeFixture(t, true);

  expect(await knowledgeProblems(runtime)).toEqual([
    { path: "org/knowledge/broken.md", reason: "It has no front matter" },
  ]);

  expect(
    (await knowledgeList(false, runtime)).map((d) => d.name),
  ).not.toContain("broken");
});

test("the session-start knowledge index is empty without documents", () => {
  expect(knowledgeIndexText([])).toBe("");
});

test("the session-start knowledge index lists each document on one line", async (t) => {
  const { runtime } = await knowledgeFixture(t, true);
  const always = await knowledgeList(true, runtime);

  expect(
    knowledgeIndexText(
      always.map((doc) => ({ ...doc, description: "two\nlines\r\nand more" })),
    ),
  ).toBe(
    [
      "Available organization knowledge (retrieve full content with barndog knowledge get <name>):",
      "- release-notes: two lines and more",
      "- local-context: two lines and more",
    ].join("\n"),
  );
});

async function hookFixture(
  t: TestContext,
  manifest?: string,
  harnesses: Harness[] = ["claude", "codex", "cursor"],
) {
  const server = await cloud(t);
  const runtime = testRuntime(server.home);
  const local = await localWorkspace(runtime);
  await saveSettings({ harnesses, localWorkspace: local }, server.home);
  for (const file of packages.hook) {
    const path = join(local.path, "org/hooks/release-notes", file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      file.path === "hook.yaml" && manifest
        ? manifest
        : Buffer.from(file.content, "base64"),
    );
  }

  return runtime;
}

const BOTH_HARNESSES = [
  "name: release-notes",
  "description: Checks release notes",
  "implementations:",
  "  claude:",
  "    compatibility: supported",
  "    scripts: [scripts/hook.sh]",
  "    requirements:",
  "      commands: [sh]",
  "    events:",
  "      SessionStart:",
  "        - hooks:",
  "            - type: command",
  "              command: '${BARNDOG_HOOK_ROOT}/scripts/hook.sh'",
  "  codex:",
  "    compatibility: supported",
  "    scripts: [scripts/hook.sh]",
  "    requirements:",
  "      commands: [barndog-test-missing-runtime]",
  "    events:",
  "      SessionStart:",
  "        - hooks:",
  "            - type: command",
  "              command: '${BARNDOG_HOOK_ROOT}/scripts/hook.sh'",
  "",
].join("\n");

test("local hook compatibility reports an implementation for each declared harness and none for the rest", async (t) => {
  const runtime = await hookFixture(t, BOTH_HARNESSES);
  const result = await hookCompatibility("release-notes", "org", runtime);
  const row = (harness: string) =>
    result.compatibility.find((r) => r.harness === harness)!;

  expect(row("claude")).toMatchObject({
    status: "supported",
    runtimeIssue: null,
  });

  expect(row("claude").implementation).not.toBeNull();
  expect(row("codex").implementation).not.toBeNull();
  expect(row("cursor")).toMatchObject({
    implementation: null,
    status: "unsupported",
    runtimeIssue: "No implementation for this harness",
  });
});

test("local hook compatibility reports a missing runtime for the harness that needs it", async (t) => {
  const runtime = await hookFixture(t, BOTH_HARNESSES);
  const result = await hookCompatibility("release-notes", "org", runtime);

  expect(
    Object.fromEntries(
      result.compatibility.map((r) => [r.harness, r.runtimeIssue]),
    ),
  ).toMatchObject({
    claude: null,
    codex:
      "needs the barndog-test-missing-runtime command, which isn't installed here or isn't on your PATH",
  });
});

test("a hook that only implements Claude Code is unsupported for Codex and Cursor", async (t) => {
  const runtime = await hookFixture(t);
  const result = await hookCompatibility("release-notes", "org", runtime);
  const row = (harness: string) =>
    result.compatibility.find((r) => r.harness === harness)!;

  expect(row("claude").implementation).not.toBeNull();
  for (const harness of ["codex", "cursor"]) {
    expect(row(harness).runtimeIssue).toBe(
      "No implementation for this harness",
    );
  }
});

test("hook compatibility lists only the coding tools BarnDog manages", async (t) => {
  const runtime = await hookFixture(t, BOTH_HARNESSES, [
    "claude",
    "codex",
    "opencode",
  ]);

  const result = await hookCompatibility("release-notes", "org", runtime);

  expect(result.compatibility.map((row) => row.harness)).toStrictEqual([
    "claude",
    "codex",
  ]);
});

test("hooks show describes a local Hook and the events each tool runs it on", async (t) => {
  const runtime = await hookFixture(t, BOTH_HARNESSES);
  const details = await showPackage("hook", "release-notes", "local", runtime);

  expect(details).toMatchObject({
    kind: "hook",
    name: "release-notes",
    description: "Checks release notes",
    events: { claude: ["SessionStart"], codex: ["SessionStart"] },
  });

  const text = stripVTControlCharacters(
    renderPackageDetails({
      ...details,
      installed: {
        state: "installed",
        harnesses: ["claude"],
        paths: ["/home/dev/.claude/settings.json"],
      },
    }).join("\n"),
  );

  expect(text).toMatch(
    /Tools\n\s+Tool\s+Author says\s+On this machine\s+Events/,
  );

  expect(text).toMatch(/Claude Code\s+supported\s+✔ ready\s+SessionStart/);
  expect(text).toMatch(
    /Codex\s+supported\s+! missing requirement\s+SessionStart/,
  );

  expect(text).toMatch(
    /Codex\s+barndog-test-missing-runtime command\s+! not installed/,
  );

  expect(text).toMatch(/Installed in\s+Claude Code/);
  expect(text).toMatch(/Paths\n {2}\/home\/dev\/\.claude\/settings\.json/);
  expect(
    stripVTControlCharacters(
      renderPackageDetails({
        ...details,
        events: {},
        compatibility: undefined,
        installed: null,
      }).join("\n"),
    ),
  ).toMatch(/State\s+not installed[\s\S]*No coding tool runs it/);
});

const ONLY_CODEX = (requirements: string) =>
  [
    "name: release-notes",
    "description: Checks release notes",
    "implementations:",
    "  codex:",
    "    compatibility: supported",
    "    scripts: [scripts/hook.sh]",
    "    requirements:",
    `      commands: [${requirements}]`,
    "    events:",
    "      SessionStart:",
    "        - hooks:",
    "            - type: command",
    "              command: '${BARNDOG_HOOK_ROOT}/scripts/hook.sh'",
    "",
  ].join("\n");

test("a Hook no selected tool can run says why rather than staying pending", async (t) => {
  const folder = async (manifest: string) => {
    const runtime = await hookFixture(t, manifest, ["claude", "codex"]);
    const settings = (await readSettings(runtime.home))!;

    return {
      runtime,
      path: join(settings.localWorkspace!.path, "org/hooks/release-notes"),
    };
  };

  const missing = await folder(ONLY_CODEX("barndog-test-missing-runtime"));
  expect(
    await hookBlocked(missing.path, ["claude", "codex"], missing.runtime),
  ).toBe("cant-run");

  expect(await hookBlocked(missing.path, ["claude"], missing.runtime)).toBe(
    "no-version",
  );

  expect(await hookBlocked(missing.path, ["opencode"], missing.runtime)).toBe(
    "no-version",
  );

  expect(await hookBlocked(missing.path, [], missing.runtime)).toBeNull();

  const runnable = await folder(ONLY_CODEX("sh"));
  expect(
    await hookBlocked(runnable.path, ["claude", "codex"], runnable.runtime),
  ).toBeNull();

  expect(
    await hookBlocked(
      join(runnable.path, "nowhere"),
      ["codex"],
      runnable.runtime,
    ),
  ).toBeNull();

  await writeFile(join(runnable.path, "hook.yaml"), "name: [broken");
  expect(
    await hookBlocked(runnable.path, ["codex"], runnable.runtime),
  ).toBeNull();
});
