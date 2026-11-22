/** What `barndog uninstall` would find to remove or leave on this machine. */
import { lstat } from "node:fs/promises";
import { basename } from "node:path";

import { barndogPaths } from "../../config/paths.js";
import { readSettings } from "../../config/settings.js";
import { readState, type State } from "../../config/state.js";
import { CliError } from "../../errors.js";
import { secretRefs } from "../../harnesses/formats.js";
import { adapters } from "../../harnesses/registry.js";
import type { Harness } from "../../harnesses/types.js";
import type { RuntimeContext } from "../../runtime.js";
import { ifExists, isInside } from "../../shared/files.js";
import { readCredentials } from "../auth/credentials.js";
import {
  readAdoptions,
  summary,
  type AdoptedAsset,
} from "../adoption/record.js";
import { convertServer, type ConvertedServer } from "../mcps/import.js";
import type { NativeEntry } from "../native/configuration.js";

/** One Skill, MCP server or Hook BarnDog installed in one coding tool. */
export type InstalledAsset = {
  kind: "skill" | "mcp" | "hook";
  name: string;
  harness: Harness;
};

/**
 * A variable an MCP server BarnDog installed reads from the environment, and
 * the servers that read it. Once BarnDog is gone, keeping it set is up to the
 * developer.
 */
export type McpVariable = { name: string; servers: string[] };

export type UninstallSurvey = {
  /** `~/.barndog/`, which uninstall deletes. */
  root: string;
  installed: InstalledAsset[];
  /** Adopted assets whose originals can still be put back. */
  adopted: AdoptedAsset[];
  /** The local workspace folder, which uninstall can keep inside `~/.barndog/`. */
  workspace?: string;
  /** Servers this machine is signed in to. */
  servers: string[];
  variables: McpVariable[];
};

/** The installed folder name a Hook registration's asset ID refers to. */
const hookName = (id: string, state: State) => {
  const folder = state.installed.find(
    (entry) => entry.kind === "hook" && entry.id === id,
  );

  return folder ? basename(folder.path) : id;
};

/** Each asset once per tool; a Hook has one entry per event it handles. */
function installedAssets(state: State): InstalledAsset[] {
  const assets: InstalledAsset[] = state.links.map((link) => ({
    kind: "skill",
    name: basename(link.target),
    harness: link.harness,
  }));

  for (const entry of state.native) {
    if (entry.kind !== "mcp" && entry.kind !== "hook") {
      continue;
    }

    const name = entry.kind === "mcp" ? entry.key : hookName(entry.id, state);
    if (
      !assets.some(
        (asset) =>
          asset.kind === entry.kind &&
          asset.name === name &&
          asset.harness === entry.harness,
      )
    ) {
      assets.push({ kind: entry.kind, name, harness: entry.harness });
    }
  }

  return assets;
}

/** An MCP entry BarnDog wrote, read back the way `mcp add --from` reads one. */
function definitionOf(entry: NativeEntry): ConvertedServer | undefined {
  const { imported } = adapters[entry.harness].mcp;
  try {
    return convertServer({
      name: entry.key,
      server: imported ? imported(entry.value) : entry.value,
    });
  } catch (error) {
    if (error instanceof CliError) {
      return undefined;
    }

    throw error;
  }
}

/**
 * The variables BarnDog's MCP entries read from the environment, each once.
 * A value BarnDog kept is written into the entry, so it isn't one of them.
 */
export function mcpVariables(state: State): McpVariable[] {
  const variables = new Map<string, Set<string>>();
  for (const entry of state.native) {
    const converted = entry.kind === "mcp" ? definitionOf(entry) : undefined;
    if (!converted) {
      continue;
    }

    const written = new Set(converted.literals.map(({ variable }) => variable));
    for (const { secretRef } of Object.values(
      secretRefs(converted.definition),
    )) {
      if (!written.has(secretRef)) {
        variables.set(
          secretRef,
          (variables.get(secretRef) ?? new Set()).add(entry.key),
        );
      }
    }
  }

  return [...variables].map(([name, servers]) => ({
    name,
    servers: [...servers],
  }));
}

export async function uninstallSurvey(
  runtime: RuntimeContext,
): Promise<UninstallSurvey> {
  const { home } = runtime;
  const root = barndogPaths(home).root;

  // A damaged config.yaml shouldn't stop an uninstall; only the workspace path comes from it.
  const settings = await readSettings(home).catch(() => null);
  const state = await readState(home);
  const adoptions = await readAdoptions(home);
  const { servers } = await readCredentials(runtime);

  const local = settings?.localWorkspace?.path;
  // Setup always puts it in ~/.barndog/workspace; a path edited to point
  // elsewhere is outside what uninstall deletes, so there is nothing to ask.
  const workspace =
    local && isInside(root, local) && (await ifExists(lstat(local)))
      ? local
      : undefined;

  return {
    root,
    installed: installedAssets(state),
    adopted: adoptions
      .filter((record) => record.status !== "undone")
      .flatMap((record) => summary(record).items)
      .filter((item) => !item.undone),
    workspace,
    servers: Object.keys(servers),
    variables: mcpVariables(state),
  };
}
