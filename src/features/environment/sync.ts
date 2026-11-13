import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { hookManifestSchema } from "@barndog-ai/api-contract";
import { readState, type Link } from "../../config/state.js";
import {
  readSettings,
  settingsPath,
  settingsText,
  SetupRequiredError,
  type Settings,
} from "../../config/settings.js";
import { packageFingerprint } from "@barndog-ai/api-contract/package";
import { CliError } from "../../errors.js";
import {
  desiredEntries,
  installedPath,
  installedRoot,
  treeFingerprint,
} from "./installed.js";
import {
  installedName,
  originLabel,
  hookFolders,
  resolveClashes,
  type ClashResolver,
} from "./names.js";
import { selectionState, withSelection } from "../../config/environment.js";
import { harnesses, skillDirectory } from "../../harnesses/registry.js";
import type { SyncEvent } from "./events.js";
import { resolveAssets } from "../asset-selection/index.js";
import { pruneCache } from "./packages.js";
import { followImports } from "../imports/local.js";
import { adoptMoved, localOverlay } from "../git-workspace/overlay.js";
import { openWorkspaceSource, type RefreshPolicy } from "./workspace-source.js";
import type { WorkspaceSource } from "./source.js";
import {
  nativeFile,
  patchNative,
  type NativeEntry,
} from "../native/configuration.js";
import {
  hookEntries,
  mcpEntry,
  runtimeRequirements,
} from "../native/adapters.js";
import { shellQuote } from "../../shared/shell.js";
import {
  atomicFile,
  fileText,
  linkTarget,
  locked,
  transact,
  type Write,
} from "./transaction.js";
import type { AssetCatalog } from "../asset-selection/types.js";
import {
  assetKinds,
  packageKindList,
  type PackageKind,
} from "../asset-kinds/index.js";
import { defined } from "../../shared/lookup.js";

const nativeSchema = z.array(
  z
    .object({
      id: z.string(),
      kind: z.enum(["mcp", "hook", "knowledge", "sync"]),
      harness: z.enum(harnesses),
      file: z.string(),
      key: z.string(),
      value: z.record(z.string(), z.unknown()),
    })
    .strict(),
);

/** The name an asset is installed under right now, whatever settings say it should be. */
function heldName(
  id: string,
  links: readonly Link[],
  native: readonly { id: string; kind: string; key: string }[],
) {
  const held =
    links.find((link) => link.id === id)?.target ??
    native.find((entry) => entry.id === id && entry.kind === "mcp")?.key;
  return held ? basename(held) : undefined;
}

/** Looks up installed names from state, for checks made outside a sync. */
export async function installedNames(home: string) {
  const path = join(home, ".barndog/state.json");
  const raw = await fileText(path);
  const { links } = await readState(path, home);
  const { native } = readStateFile(raw);
  return (id: string) => heldName(id, links, native);
}

function inside(parent: string, child: string) {
  const path = relative(parent, child);
  return (
    !path ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

export type SyncOptions = {
  checkpoint?: (index: number) => Promise<void>;
  catalog?: AssetCatalog;
  dryRun?: boolean;
  /** false never prompts, even when a terminal resolver is registered. */
  prompt?: boolean;
  resolveClash?: ClashResolver;
  /** How a repo-backed workspace looks for new commits. */
  refresh?: RefreshPolicy;
  source?: WorkspaceSource;
};

/** The CLI registers a terminal prompt here; library callers default to skipping. */
export const clashPrompt: { resolver?: ClashResolver } = {};

type InstalledTree = {
  id: string;
  kind: PackageKind;
  path: string;
  source: string;
  rename: string | null;
  fingerprint: string;
  versionId: string;
};

const installedSchema = z.array(
  z
    .object({
      id: z.string(),
      kind: z.enum(packageKindList),
      path: z.string(),
      fingerprint: z.string(),
      versionId: z.string().optional(),
    })
    .strict(),
);

/** The parts of state.json this module owns; links are read by readState(). */
const stateFileSchema = z.looseObject({
  native: nativeSchema.default([]),
  installed: installedSchema.default([]),
});

const readStateFile = (raw: string | null) =>
  stateFileSchema.parse(raw ? JSON.parse(raw) : {});

export async function synchronize(
  configPath?: string,
  home = homedir(),
  override?: Settings,
  options: SyncOptions = {},
): Promise<SyncEvent[]> {
  home = resolve(home);
  return locked(home, async () => {
    const path = resolve(configPath ?? settingsPath(home));
    const settings = override ?? (await readSettings(home, path));
    if (!settings) throw new SetupRequiredError();
    if (home === homedir()) {
      if (
        settings.harnesses.includes("claude") &&
        process.env.CLAUDE_CONFIG_DIR
      )
        throw new Error(
          "Custom CLAUDE_CONFIG_DIR is not supported by this delivery adapter; use the standard user configuration location",
        );
      if (
        settings.harnesses.includes("codex") &&
        process.env.CODEX_HOME &&
        resolve(process.env.CODEX_HOME) !== join(home, ".codex")
      )
        throw new Error(
          "Custom CODEX_HOME is not supported by this delivery adapter; use ~/.codex",
        );
    }
    const stateFile = join(home, ".barndog/state.json"),
      rawState = await fileText(stateFile);
    const before = await readState(stateFile, home);
    const { native: oldNative, installed: installedState } =
      readStateFile(rawState);
    for (const entry of oldNative)
      if (entry.file !== nativeFile(entry.harness, entry.kind, home))
        throw new Error("Invalid native installation state");
    for (const entry of installedState)
      if (dirname(entry.path) !== installedRoot(home, entry.kind))
        throw new Error("Invalid installed package state");
    let selection = selectionState(settings);
    const followNotices =
      settings.localWorkspace && !options.dryRun
        ? await followImports(
            settings.localWorkspace.path,
            options.refresh ?? "always",
          ).catch(() => [])
        : [];
    const source =
      options.source ??
      openWorkspaceSource(settings, home, {
        refresh: options.refresh,
      });
    if (
      !source &&
      (selection.subscriptions.length || selection.individualAssetIds.length)
    )
      throw new Error("Remote selections require a connection");
    const catalog = source
      ? (options.catalog ?? (await source.catalog()))
      : { assets: [], distributions: [] };
    const overlay = localOverlay(settings, home);
    if (overlay)
      selection = await adoptMoved(
        overlay,
        catalog,
        selection,
        !options.dryRun,
      );
    const invalid: ReadonlyMap<string, string> = source
      ? await source.invalidAssets()
      : new Map();
    let effective = resolveAssets(catalog, selection);
    if (effective.diagnostics.length)
      throw new CliError(
        `Some selected assets or scopes are no longer available; nothing was changed: ${effective.diagnostics.map((d) => (d.type === "missing-asset" ? d.assetId : `${d.scope.type}/${d.scope.id}`)).join(", ")}`,
        "barndog status",
      );
    const desired: Link[] = [],
      native: NativeEntry[] = [],
      trees: InstalledTree[] = [],
      events: SyncEvent[] = [
        ...new Set([
          ...followNotices,
          ...(source?.notices() ?? []),
          ...((await source?.warnings?.()) ?? []),
          ...((await overlay?.warnings?.()) ?? []),
        ]),
      ].map((message) => ({
        type: "notice",
        message,
      })),
      names = new Set<string>(),
      ids = new Set<string>();
    // Installed names share one namespace per kind; resolve clashes before staging.
    const owned = (id: string) =>
      before.links.some((link) => link.id === id) ||
      oldNative.some((entry) => entry.id === id && entry.kind === "mcp");
    // An invalid asset can only stay installed while its own folder is still there.
    const vanished = new Set<string>();
    for (const entry of installedState) {
      if (!invalid.has(entry.id)) continue;
      const actual = await treeFingerprint(entry.path);
      const shared = installedState.some(
        (other) => other.id !== entry.id && other.path === entry.path,
      );
      if (actual === null || (shared && actual !== entry.fingerprint))
        vanished.add(entry.id);
    }
    const savedNames = settings.localNames ?? {};
    // An invalid asset stays under the name it's installed at, whatever it was renamed to since.
    const heldNames = new Map<string, string>();
    for (const { asset, enabled } of effective.assets) {
      if (!enabled || !invalid.has(asset.id) || vanished.has(asset.id))
        continue;
      const held = heldName(asset.id, before.links, oldNative);
      if (held) heldNames.set(asset.id, held);
    }
    const outcome = await resolveClashes(
      [
        ...effective.assets.flatMap(({ asset, enabled }) => {
          const { kind } = asset;
          if (
            !enabled ||
            kind === "hook" ||
            (invalid.has(asset.id) &&
              (!owned(asset.id) || vanished.has(asset.id)))
          )
            return [];
          return [
            {
              id: asset.id,
              kind,
              name: asset.name,
              origin: asset.origin,
              installed: owned(asset.id),
              renamable: !invalid.has(asset.id),
            },
          ];
        }),
      ],
      { ...savedNames, ...Object.fromEntries(heldNames) },
      options.prompt === false || options.dryRun
        ? undefined
        : (options.resolveClash ?? clashPrompt.resolver),
    );
    const localNames = { ...outcome.localNames };
    for (const id of heldNames.keys()) {
      if (savedNames[id] === undefined) delete localNames[id];
      else localNames[id] = savedNames[id];
    }
    selection = {
      ...selection,
      disabledAssetIds: [
        ...new Set([
          ...selection.disabledAssetIds,
          ...outcome.disabledAssetIds,
        ]),
      ],
    };
    effective = resolveAssets(catalog, selection);
    const skipped = new Set(outcome.skipped.map((clash) => clash.incoming.id));
    for (const clash of outcome.skipped)
      events.push({
        type: "clash",
        kind: clash.kind,
        name: clash.name,
        installed: {
          name: clash.installed.name,
          origin: originLabel(clash.installed.origin),
        },
        skipped: {
          name: clash.incoming.name,
          origin: originLabel(clash.incoming.origin),
          rename: clash.incomingRename,
        },
      });
    const addSkill = (id: string, source: string, name: string) => {
      if (names.has(name))
        throw new CliError(
          `Two enabled Skills are named ${name}`,
          "barndog doctor",
        );
      names.add(name);
      for (const harness of settings.harnesses) {
        const target = resolve(skillDirectory(harness, home), name);
        if (inside(source, target) || inside(target, source))
          throw new Error(`Source overlaps installation: ${source}`);
        desired.push({ id, harness, source, target });
      }
    };
    const stage = async (
      id: string,
      kind: PackageKind,
      name: string,
      source: string,
      rename: string | null,
      versionId: string,
    ) => {
      const path = installedPath(home, kind, name);
      trees.push({
        id,
        kind,
        path,
        source,
        rename,
        versionId,
        fingerprint: packageFingerprint(await desiredEntries(source, rename)),
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
              installedState.some((tree) => tree.id === asset.id)),
        )
        .map(({ asset }) => {
          const tree = installedState.find((entry) => entry.id === asset.id);
          const folder = tree && basename(tree.path);
          return {
            ...asset,
            ...(folder
              ? invalid.has(asset.id)
                ? { kept: folder }
                : { current: folder }
              : {}),
          };
        }),
      localNames,
    );
    for (const chosen of effective.assets) {
      const ref = chosen.asset;
      if (ids.has(ref.id))
        throw new Error("Remote asset ID conflicts with a local selection");
      ids.add(ref.id);
      if (!chosen.enabled) {
        events.push({ type: "disabled", id: ref.id });
        continue;
      }
      if (skipped.has(ref.id)) continue;
      const reason = invalid.get(ref.id);
      if (reason) {
        // Nothing validates a repo before merge, so a bad change must not uninstall what works.
        events.push({
          type: "invalid",
          kind: ref.kind,
          name: ref.name,
          reason,
        });
        if (vanished.has(ref.id)) continue;
        for (const link of before.links.filter((l) => l.id === ref.id)) {
          desired.push(link);
          names.add(basename(link.target));
        }
        native.push(...oldNative.filter((entry) => entry.id === ref.id));
        const tree = installedState.find((entry) => entry.id === ref.id);
        if (tree)
          trees.push({
            id: tree.id,
            kind: tree.kind,
            path: tree.path,
            source: tree.path,
            rename: null,
            fingerprint: tree.fingerprint,
            versionId: tree.versionId ?? ref.publishedVersion,
          });
        continue;
      }
      // Without a source the catalog is empty, so this never runs.
      if (!source) throw new Error("Catalog assets need a workspace source");
      const name = installedName(ref, localNames);
      if (ref.kind === "skill") {
        const cache = await source.skillOrHookPackage("skill", ref);
        addSkill(
          ref.id,
          await stage(
            ref.id,
            "skill",
            name,
            cache,
            name === ref.name ? null : name,
            ref.publishedVersion,
          ),
          name,
        );
      } else if (ref.kind === "mcp") {
        const definition = await source.mcpDefinition(ref);
        for (const harness of settings.harnesses)
          native.push(
            mcpEntry(harness, { id: ref.id, name }, definition, home),
          );
      } else {
        const cache = await source.skillOrHookPackage("hook", ref);
        const manifest = hookManifestSchema.parse(
          parse(await readFile(join(cache, "hook.yaml"), "utf8")),
        );
        // Hook folders are internal, so collisions are settled without prompting.
        const root = await stage(
          ref.id,
          "hook",
          defined(folders.get(ref.id), `No Hook folder chosen for ${ref.id}`),
          cache,
          null,
          ref.publishedVersion,
        );
        for (const harness of settings.harnesses) {
          const implementation = manifest.implementations[harness];
          const reason = !implementation
            ? "No implementation for this harness"
            : await runtimeRequirements(harness, implementation.requirements);
          if (reason) {
            events.push({
              type: "unsupported",
              kind: "hook",
              harness,
              name: ref.name,
              reason,
            });
            continue;
          }
          native.push(...hookEntries(harness, ref.id, root, manifest, home));
        }
      }
    }
    if (source && settings.knowledge !== false) {
      const script = fileURLToPath(
        new URL("../knowledge/startup.js", import.meta.url),
      );
      for (const harness of settings.harnesses) {
        const command = `${shellQuote(process.execPath)} ${shellQuote(script)} ${harness} ${shellQuote(home)}`;
        native.push({
          id: "barndog-knowledge-index",
          kind: "knowledge",
          harness,
          file: nativeFile(harness, "knowledge", home),
          key: harness === "cursor" ? "sessionStart" : "SessionStart",
          value:
            harness === "cursor"
              ? { command }
              : { hooks: [{ type: "command", command }] },
        });
      }
    }
    if (
      settings.connection ||
      settings.gitWorkspace ||
      settings.localWorkspace
    ) {
      const script = fileURLToPath(
        new URL("../git-workspace/startup.js", import.meta.url),
      );
      for (const harness of settings.harnesses) {
        const command = `${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(home)}`;
        native.push({
          id: "barndog-workspace-sync",
          kind: "sync",
          harness,
          file: nativeFile(harness, "sync", home),
          key: harness === "cursor" ? "sessionStart" : "SessionStart",
          value:
            harness === "cursor"
              ? { command }
              : { hooks: [{ type: "command", command }] },
        });
      }
    }
    // Hook registrations carry IDs; show the asset or folder name instead.
    const hookNames = new Map<string, string>([
      ...installedState.map((t) => [t.id, basename(t.path)] as const),
      // Still known after being deselected, unlike the effective set below.
      ...catalog.assets.map((a) => [a.id, a.name] as const),
      ...effective.assets.map((e) => [e.asset.id, e.asset.name] as const),
    ]);
    const nativeName = (entry: { kind: string; key: string; id: string }) =>
      entry.kind === "mcp"
        ? entry.key
        : entry.kind === "knowledge"
          ? "knowledge index"
          : entry.kind === "sync"
            ? "workspace sync"
            : (hookNames.get(entry.id) ?? entry.id);
    const writes: Write[] = [];
    for (const entry of installedState) {
      const actual = await treeFingerprint(entry.path);
      // Older versions could record two Hooks at one path; either copy is ours.
      if (
        actual !== null &&
        !installedState.some(
          (other) => other.path === entry.path && other.fingerprint === actual,
        )
      )
        throw new CliError(
          `The installed copy at ${entry.path} was edited by hand. Syncing would overwrite those edits. ${
            settings.localWorkspace &&
            !settings.connection &&
            !settings.gitWorkspace
              ? "To keep them, copy that folder somewhere else first."
              : `To keep them, make an editable copy with \`barndog ${assetKinds[entry.kind].command} pull\` first.`
          }`,
          `rm -rf ${shellQuote(entry.path)} && barndog sync`,
        );
    }
    for (const treePath of new Set([
      ...installedState.map((entry) => entry.path),
      ...trees.map((tree) => tree.path),
    ])) {
      const next = trees.find((tree) => tree.path === treePath);
      writes.push({
        kind: "tree",
        path: treePath,
        before: await treeFingerprint(treePath),
        after: next?.fingerprint ?? null,
        source: next?.source ?? null,
        rename: next?.rename ?? null,
      });
    }
    const updated = new Set(
      writes
        .filter(
          (w) =>
            w.kind === "tree" &&
            w.before !== null &&
            w.after !== null &&
            w.before !== w.after,
        )
        .map((w) => w.path),
    );
    for (const link of before.links) {
      const actual = await linkTarget(link.target);
      if (actual !== null && actual !== link.source)
        throw new Error(`Managed link was changed externally: ${link.target}`);
    }
    for (const link of desired) {
      const actual = await linkTarget(link.target),
        old = before.links.find((l) => l.target === link.target);
      if (actual !== null && !old)
        throw new Error(`Existing unmanaged Skill: ${link.target}`);
    }
    for (const target of new Set([
      ...before.links.map((l) => l.target),
      ...desired.map((l) => l.target),
    ])) {
      const old = before.links.find((l) => l.target === target),
        next = desired.find((l) => l.target === target),
        actual = await linkTarget(target);
      if (old && (!next || next.id !== old.id))
        events.push({ type: "removed", link: old });
      if (next)
        events.push({
          type:
            actual === next.source && old?.id === next.id
              ? updated.has(next.source)
                ? "updated"
                : "unchanged"
              : old?.id === next.id
                ? "updated"
                : "installed",
          link: next,
        });
      writes.push({
        kind: "link",
        path: target,
        before: actual,
        after: next?.source ?? null,
      });
    }
    for (const file of new Set([
      ...oldNative.map((e) => e.file),
      ...native.map((e) => e.file),
    ])) {
      const old = oldNative.filter((e) => e.file === file),
        next = native.filter((e) => e.file === file),
        text = await fileText(file);
      writes.push({
        kind: "file",
        path: file,
        before: text,
        after: patchNative(text, old, next),
      });
      for (const entry of next)
        events.push({
          type: "native",
          action: old.some((e) => JSON.stringify(e) === JSON.stringify(entry))
            ? entry.kind === "hook" &&
              trees.some((t) => t.id === entry.id && updated.has(t.path))
              ? "updated"
              : "unchanged"
            : old.some((e) => e.id === entry.id && e.harness === entry.harness)
              ? "updated"
              : "installed",
          kind: entry.kind,
          harness: entry.harness,
          name: nativeName(entry),
        });
      for (const entry of old)
        if (
          !next.some(
            (e) =>
              JSON.stringify(e) === JSON.stringify(entry) ||
              (e.id === entry.id && e.harness === entry.harness),
          )
        )
          events.push({
            type: "native",
            action: "removed",
            kind: entry.kind,
            harness: entry.harness,
            name: nativeName(entry),
          });
    }
    const nextState =
      JSON.stringify(
        {
          version: 1,
          links: desired,
          native,
          installed: trees.map(
            ({ id, kind, path, fingerprint, versionId }) => ({
              id,
              kind,
              path,
              fingerprint,
              versionId,
            }),
          ),
        },
        null,
        2,
      ) + "\n";
    writes.push({
      kind: "file",
      path: stateFile,
      before: rawState,
      after: nextState,
    });
    // Explicit overrides are one-shot delivery inputs, never a change to default preferences.
    if (!configPath) {
      const next = source
        ? withSelection(settings, selection)
        : { ...settings };
      if (Object.keys(localNames).length) next.localNames = localNames;
      else delete next.localNames;
      writes.push({
        kind: "file",
        path: settingsPath(home),
        before: await fileText(settingsPath(home)),
        after: settingsText(next),
      });
    }
    if (options.dryRun) return events;
    await transact(home, writes, source?.journal, options.checkpoint);
    // Only versions the installed folders were just filled from are worth keeping.
    if (source)
      for (const key of [source.cacheKey, ...(source.extraCacheKeys ?? [])])
        await pruneCache(
          key,
          home,
          new Set(trees.map((tree) => dirname(tree.source))),
        ).catch(() => 0);
    return events;
  });
}

export { atomicFile };
