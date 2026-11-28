import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { barndogPaths } from "../config/paths.js";
import { signInTools } from "../features/mcps/import.js";
import { nativeFile } from "../harnesses/registry.js";
import type { Harness } from "../harnesses/types.js";
import { testRuntime } from "./runtime.js";

test("sign-in finds a server's tools by asset ID, even under a clash rename", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "barndog-sign-in-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));

  const entry = (id: string, harness: Harness, key: string) => ({
    id,
    kind: "mcp",
    harness,
    file: nativeFile(harness, "mcp", home),
    key,
    value: {},
  });

  const state = barndogPaths(home).state;
  await mkdir(dirname(state), { recursive: true });
  await writeFile(
    state,
    JSON.stringify({
      version: 1,
      links: [],
      native: [
        // Codex already had a docs server, so this one was renamed there.
        entry("docs-id", "claude", "docs"),
        entry("docs-id", "codex", "local-docs-docs"),
        entry("other-id", "cursor", "docs"),
      ],
      installed: [],
    }),
  );

  const oauth = {
    transport: "http",
    url: "https://docs.test/mcp",
    headers: {},
    authentication: "native-oauth",
    description: "docs",
  } as const;

  expect(
    await signInTools(
      [
        { id: "docs-id", name: "docs", definition: oauth },
        {
          id: "plain-id",
          name: "plain",
          definition: { ...oauth, authentication: "none" },
        },
      ],
      testRuntime(home),
    ),
  ).toStrictEqual([{ server: "docs", harnesses: ["claude", "codex"] }]);
});
