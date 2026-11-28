/**
 * Stages every enabled asset for one sync: fetches its package or definition
 * from the workspace source and works out the Skill links, native entries and
 * installed folders it needs. Nothing is written to a destination here.
 */
import type { RuntimeContext } from "../../runtime.js";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse } from "yaml";
import {
  hookManifestSchema,
  type HookManifest,
  type McpDefinition,
} from "@barndog-ai/api-contract";
import { packageFingerprint } from "@barndog-ai/api-contract/package";

import type { PackageKind } from "../../config/selection.js";
import type { Link, State } from "../../config/state.js";
import { CliError } from "../../errors.js";
import { isHookHarness, skillDirectory } from "../../harnesses/registry.js";
import type { Harness } from "../../harnesses/types.js";
import { isInside } from "../../shared/files.js";
import { defined } from "../../shared/lookup.js";
import type { SelectionResult } from "../asset-selection/types.js";
import { hookEntries, hookIssue, mcpEntry } from "../native/adapters.js";
import { skipReason, type HookSkip } from "../native/requirements.js";
import type { NativeEntry } from "../native/configuration.js";
import {
  applyKeptValues,
  missingValues,
  type Secrets,
  type ServerValues,
} from "../secrets/index.js";
import { desiredEntries, installedPath } from "../workspace/installed.js";
import type { WorkspaceSource } from "../workspace/source.js";
import type { SyncEvent } from "./events.js";
import { hookFolders, installedName } from "./names.js";
import type { InstalledTree } from "./writes.js";

export type StagedAssets = {
  links: Link[];
  native: NativeEntry[];
  trees: InstalledTree[];
  events: SyncEvent[];
};

/**
 * One event per variable an installed MCP server refers to that has no value
 * here, and one per value kept from a version 1 file that no server has.
 */
function valueEvents(
  servers: readonly {
    name: string;
    definition: McpDefinition;
    values: ServerValues;
  }[],
  kept: Secrets,
  env: NodeJS.ProcessEnv,
): SyncEvent[] {
  return [
    ...servers.flatMap(({ name, definition, values }) =>
      missingValues(definition, values, env).map((missing): SyncEvent => ({
        type: "unset-variable",
        server: name,
        ...missing,
      })),
    ),
    ...Object.keys(kept.unassigned).map((variable): SyncEvent => ({
      type: "unassigned-value",
      variable,
    })),
  ];
}

export async function stageAssets(input: {
  assets: SelectionResult["assets"];
  /** Asset ID → why the workspace's copy can't be installed. */
  invalid: ReadonlyMap<string, string>;
  /** Invalid assets with nothing installed left to keep. */
  vanished: ReadonlySet<string>;
  /** Assets a name clash leaves out of this run. */
  skipped: ReadonlySet<string>;
  localNames: Record<string, string>;
  state: State;
  /** Absent when no workspace is connected; the catalog is then empty. */
  source: WorkspaceSource | undefined;
  harnesses: readonly Harness[];
  /** MCP values BarnDog keeps on this machine, written into the tools' settings. */
  kept: Secrets;
  runtime: RuntimeContext;
}): Promise<StagedAssets> {
  const { invalid, vanished, skipped, localNames, source, harnesses, runtime } =
    input;

  const { home } = runtime;

  const effective = { assets: input.assets };
  const { links, native: previousNative, installed } = input.state;
  const desired: Link[] = [];
  const native: NativeEntry[] = [];
  const trees: InstalledTree[] = [];
  const events: SyncEvent[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  /** Installed MCP servers, to report the variables they find no value for. */
  const servers: {
    name: string;
    definition: McpDefinition;
    values: ServerValues;
  }[] = [];

  const addSkill = (id: string, source: string, name: string) => {
    if (names.has(name)) {
      throw new CliError(
        `Two enabled Skills are named ${name}`,
        "barndog doctor",
      );
    }

    names.add(name);
    for (const harness of harnesses) {
      const target = resolve(skillDirectory(harness, home), name);
      if (isInside(source, target) || isInside(target, source)) {
        throw new CliError(
          `${source} is inside a folder BarnDog installs into. Keep your workspace somewhere else.`,
        );
      }

      desired.push({ id, harness, source, target });
    }
  };

  const stage = async ({
    id,
    kind,
    name,
    source,
    rename,
    versionId,
  }: {
    id: string;
    kind: PackageKind;
    name: string;
    source: string;
    rename: string | null;
    versionId: string;
  }) => {
    const path = installedPath(runtime, kind, name);
    trees.push({
      id,
      kind,
      path,
      source,
      rename,
      versionId,
      fingerprint: packageFingerprint(
        await desiredEntries(source, rename, input.runtime),
      ),
    });

    return path;
  };

  const folders = hookFolders(
    effective.assets
      .filter(
        ({ asset, enabled }) =>
          enabled &&
          asset.kind === "hook" &&
          !vanished.has(asset.id) &&
          (!invalid.has(asset.id) ||
            installed.some((tree) => tree.id === asset.id)),
      )
      .map(({ asset }) => {
        const tree = installed.find((entry) => entry.id === asset.id);
        const folder = tree && basename(tree.path);

        if (!folder) {
          return asset;
        }

        return invalid.has(asset.id)
          ? { ...asset, kept: folder }
          : { ...asset, current: folder };
      }),
    localNames,
  );

  for (const chosen of effective.assets) {
    const ref = chosen.asset;
    if (ids.has(ref.id)) {
      throw new Error("A catalog asset has the same ID as a local one");
    }

    ids.add(ref.id);
    if (!chosen.enabled) {
      events.push({ type: "disabled", id: ref.id });
      continue;
    }

    if (skipped.has(ref.id)) {
      continue;
    }

    const reason = invalid.get(ref.id);
    if (reason) {
      // Nothing validates a repo before merge, so a bad change must not uninstall what works.
      events.push({
        type: "invalid",
        kind: ref.kind,
        name: ref.name,
        reason,
      });

      if (vanished.has(ref.id)) {
        continue;
      }

      for (const link of links.filter((l) => l.id === ref.id)) {
        desired.push(link);
        names.add(basename(link.target));
      }

      native.push(...previousNative.filter((entry) => entry.id === ref.id));
      const tree = installed.find((entry) => entry.id === ref.id);
      if (tree) {
        trees.push({
          id: tree.id,
          kind: tree.kind,
          path: tree.path,
          source: tree.path,
          rename: null,
          fingerprint: tree.fingerprint,
          versionId: tree.versionId,
        });
      }

      continue;
    }

    // Without a source the catalog is empty, so this never runs.
    if (!source) {
      throw new Error("Catalog assets need a workspace source");
    }

    const name = installedName(ref, localNames);
    if (ref.kind === "skill") {
      const cache = await source.packageFolder("skill", ref);
      addSkill(
        ref.id,
        await stage({
          id: ref.id,
          kind: "skill",
          name,
          source: cache,
          rename: name === ref.name ? null : name,
          versionId: ref.publishedVersion,
        }),
        name,
      );
    } else if (ref.kind === "mcp") {
      const definition = await source.mcpDefinition(ref);
      const values = input.kept.servers[ref.id] ?? {};
      const applied = applyKeptValues(definition, values);
      servers.push({ name, definition, values });
      for (const harness of harnesses) {
        native.push(
          mcpEntry(
            harness,
            { id: ref.id, name, definition: applied.definition },
            applied.kept,
            runtime,
          ),
        );
      }
    } else {
      const cache = await source.packageFolder("hook", ref);
      const manifest = hookManifestSchema.parse(
        parse(await readFile(join(cache, "hook.yaml"), "utf8")),
      );

      // Hook folders are internal, so collisions are settled without prompting.
      const root = await stage({
        id: ref.id,
        kind: "hook",
        name: defined(
          folders.get(ref.id),
          `No Hook folder chosen for ${ref.id}`,
        ),
        source: cache,
        rename: null,
        versionId: ref.publishedVersion,
      });

      const registered = await hookRegistrations(
        harnesses,
        { id: ref.id, name: ref.name, root, manifest },
        runtime,
      );

      native.push(...registered.native);
      events.push(...registered.events);
    }
  }

  events.push(...valueEvents(servers, input.kept, input.runtime.env));

  return { links: desired, native, trees, events };
}

/**
 * A Hook's registrations for each selected tool, and an `unsupported` event
 * for each tool it can't run in.
 */
async function hookRegistrations(
  harnesses: readonly Harness[],
  hook: { id: string; name: string; root: string; manifest: HookManifest },
  runtime: RuntimeContext,
): Promise<{ native: NativeEntry[]; events: SyncEvent[] }> {
  const native: NativeEntry[] = [];
  const events: SyncEvent[] = [];

  const unsupported = (harness: Harness, cause: HookSkip) =>
    events.push({
      type: "unsupported",
      kind: "hook",
      harness,
      name: hook.name,
      cause,
      reason: skipReason(harness, cause),
    });

  for (const harness of harnesses) {
    if (!isHookHarness(harness)) {
      unsupported(harness, { type: "no-command-hooks" });

      continue;
    }

    const skip = await hookIssue(harness, hook.manifest, runtime);
    if (skip !== null) {
      unsupported(harness, skip);

      continue;
    }

    native.push(...hookEntries(harness, hook, runtime));
  }

  return { native, events };
}
