import type { McpDefinition } from "@barndog-ai/api-contract";
import { expect, test, vi } from "vitest";
import type { McpServerRecord } from "../config/state.js";
import type { EffectiveAsset } from "../features/asset-selection/types.js";
import { mcpRecords } from "../features/environment/mcp-records.js";
import type { WorkspaceSource } from "../features/workspace/source.js";

const definition = (variable: string) =>
  ({
    transport: "stdio",
    command: "server",
    args: [],
    environment: { [variable]: { secretRef: variable } },
    description: "",
    authentication: "none",
  }) as unknown as McpDefinition;

const selected = (
  id: string,
  enabled: boolean,
  publishedVersion = "v1",
): EffectiveAsset => ({
  asset: {
    kind: "mcp",
    id,
    name: id,
    origin: { type: "org", id: "org" },
    publishedVersion,
  },
  enabled,
  individuallyDisabled: !enabled,
  contributions: [],
});

const known = (id: string, versionId: string): McpServerRecord => ({
  id,
  name: id,
  installedName: id,
  versionId,
  variables: ["OLD"],
  enabled: true,
});

test("records each selected MCP server, reading the workspace only for a disabled one at a new version", async () => {
  const mcpDefinition = vi.fn(async () => definition("FRESH"));
  const source = { mcpDefinition } as unknown as WorkspaceSource;

  const records = await mcpRecords({
    assets: [
      selected("staged", true),
      selected("same", false),
      selected("newer", false, "v2"),
      selected("broken", false),
      selected("gone", true),
      {
        ...selected("skill", true),
        asset: { ...selected("skill", true).asset, kind: "skill" },
      },
    ],
    previous: [
      known("same", "v1"),
      known("newer", "v1"),
      known("broken", "v1"),
    ],
    definitions: new Map([["staged", definition("STAGED")]]),
    invalid: new Map([["broken", "bad JSON"]]),
    vanished: new Set(["gone"]),
    localNames: { staged: "org-acme-staged" },
    source,
  });

  expect(
    records.map((r) => [r.id, r.installedName, r.variables, r.enabled]),
  ).toStrictEqual([
    ["staged", "org-acme-staged", ["STAGED"], true],
    ["same", "same", ["OLD"], false],
    ["newer", "newer", ["FRESH"], false],
    ["broken", "broken", ["OLD"], false],
  ]);

  expect(mcpDefinition).toHaveBeenCalledOnce();
});
