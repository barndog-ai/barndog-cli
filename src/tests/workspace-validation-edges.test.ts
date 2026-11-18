import { expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { mcpDefinitionSchema } from "@barndog-ai/api-contract";
import {
  parseConfig,
  loadWorkspace,
  CONFIG_FILE,
} from "../features/workspace/format.js";
import { folderSnapshot } from "../features/workspace/snapshot.js";
import { testRuntime } from "./runtime.js";
import { sample } from "./sample.js";
import { packages, ID } from "./cloud.js";

for (const text of ["null", "[]", "version: 2", "unknown: true"]) {
  test(`workspace configuration rejects invalid root shape ${text}`, () => {
    expect(() => parseConfig(text)).toThrow("barndog.yaml is invalid");
  });
}

test("malformed YAML in barndog.yaml is a CliError naming the file", () => {
  expect(() => parseConfig("version: [1")).toThrow(
    expect.objectContaining({
      name: "CliError",
      message: expect.stringMatching(/^barndog\.yaml isn't valid YAML/),
    }),
  );
});

test("workspace validation reports malformed names, manifests and misplaced knowledge", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "barndog-validation-edges-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const config = {
    version: 1,
    workspaceId: ID,
    name: "Fixture",
    teams: { web: { name: "Web" } },
    repositories: { app: {} },
    optional: ["org/mcp/valid", "org/skills/missing"],
  };

  const files: Record<string, string> = {
    [CONFIG_FILE]: stringify(config),
    "org/hooks/not-a-folder": "ignored",
    "org/hooks/Bad Name/hook.yaml": "invalid",
    "org/hooks/mismatch/hook.yaml": Buffer.from(
      packages.hook.find((file) => file.path === "hook.yaml")!.content,
      "base64",
    ).toString("utf8"),
    "org/hooks/mismatch/scripts/hook.sh": "echo checked\n",
    "org/mcp/valid.yaml": stringify(sample(mcpDefinitionSchema)),
    "org/mcp/Bad Name.yaml": "invalid",
    "org/mcp/ignored.txt": "ignored",
    "org/knowledge/ignored.txt": "ignored",
    "org/knowledge/Bad Name.md": "invalid",
    "org/knowledge/mismatch.md":
      "---\nname: other\ndescription: Context\n---\nBody\n",
    "teams/web/knowledge/context.md": "---\ndescription: Context\n---\nBody\n",
  };

  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(home, path)), { recursive: true });
    await writeFile(join(home, path), text);
  }

  await mkdir(join(home, "org/mcp/folder.yaml"));
  await mkdir(join(home, "org/knowledge/folder.md"));
  await mkdir(join(home, "org/skills/empty"), { recursive: true });
  const runtime = testRuntime(home);
  const model = await loadWorkspace(await folderSnapshot(home, runtime));
  expect(model.problems.map((problem) => problem.reason).join("\n")).toContain(
    "Knowledge is organization-wide",
  );

  expect(
    model.invalidKnowledge.some((problem) =>
      problem.path.endsWith("mismatch.md"),
    ),
  ).toBe(true);

  expect(
    model.assets.find((asset) => asset.kind === "hook")!.invalid,
  ).toContain("name must match");

  expect(
    model.catalog.distributions
      .flatMap((distribution) => distribution.assets)
      .some((asset) => asset.mode === "optional"),
  ).toBe(true);

  expect(model.scopes.find((scope) => scope.type === "repo")!.name).toBe("app");
  expect(
    model.problems.some((problem) =>
      problem.reason.includes("optional names a missing"),
    ),
  ).toBe(true);
});
