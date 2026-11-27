/**
 * The record of every selected MCP server that sync keeps in `state.json`,
 * disabled ones included, so `mcp env` can work from this machine alone.
 */
import type { McpDefinition } from "@barndog-ai/api-contract";

import type { McpServerRecord } from "../../config/state.js";
import { secretRefs } from "../../harnesses/formats.js";
import type {
  AssetReference,
  SelectionResult,
} from "../asset-selection/types.js";
import type { WorkspaceSource } from "../workspace/source.js";
import { installedName } from "./names.js";

/** The variables a definition refers to, each once. */
const variablesOf = (definition: McpDefinition) => [
  ...new Set(Object.values(secretRefs(definition)).map((ref) => ref.secretRef)),
];

/** A server's variables: from this sync's read, the record of the same version, or the workspace. */
async function currentVariables(input: {
  asset: AssetReference;
  known: McpServerRecord | undefined;
  staged: McpDefinition | undefined;
  source: WorkspaceSource | undefined;
}): Promise<string[]> {
  const { asset, known, staged, source } = input;

  if (staged) {
    return variablesOf(staged);
  }

  if (known?.versionId === asset.publishedVersion) {
    return known.variables;
  }

  // Without a source the catalog is empty, so this never runs.
  if (!source) {
    throw new Error("Catalog assets need a workspace source");
  }

  // Only a server this sync didn't stage, at a version not yet recorded, is read here.
  return variablesOf(await source.mcpDefinition(asset));
}

/** Every selected MCP server, for `state.json`. */
export async function mcpRecords(input: {
  assets: SelectionResult["assets"];
  /**
   * The record the last sync wrote, if any; a server whose version hasn't
   * changed keeps its variables.
   */
  previous: readonly McpServerRecord[] | undefined;
  /** Definitions this sync already read, by asset ID. */
  definitions: ReadonlyMap<string, McpDefinition>;
  /** Asset ID → why the workspace's copy can't be installed. */
  invalid: ReadonlyMap<string, string>;
  /** Invalid assets with nothing installed left to keep. */
  vanished: ReadonlySet<string>;
  localNames: Record<string, string>;
  source: WorkspaceSource | undefined;
}): Promise<McpServerRecord[]> {
  const { definitions, invalid, vanished, localNames, source } = input;
  const previous = input.previous ?? [];

  const records: McpServerRecord[] = [];

  for (const { asset, enabled } of input.assets) {
    if (asset.kind !== "mcp" || vanished.has(asset.id)) {
      continue;
    }

    const known = previous.find((record) => record.id === asset.id);
    const name = installedName(asset, localNames);

    // A copy that can't be installed tells nothing new; keep what was known.
    if (invalid.has(asset.id)) {
      if (known) {
        records.push({ ...known, installedName: name, enabled });
      }

      continue;
    }

    const variables = await currentVariables({
      asset,
      known,
      staged: definitions.get(asset.id),
      source,
    });

    records.push({
      id: asset.id,
      name: asset.name,
      installedName: name,
      versionId: asset.publishedVersion,
      variables,
      enabled,
    });
  }

  return records;
}
