import type { RuntimeContext } from "../../runtime.js";
import { basename, dirname, resolve } from "node:path";
import { readState } from "../../config/state.js";
import {
  readSettings,
  settingsText,
  SetupRequiredError,
  type Settings,
} from "../../config/settings.js";
import { CliError, friendlyMessage } from "../../errors.js";
import { type ClashResolver } from "./names.js";
import { selectionState, withSelection } from "../../config/environment.js";
import type { SyncEvent } from "./events.js";
import { heldName, settleNames } from "./settle-names.js";
import { stageAssets } from "./stage.js";
import { assertSupportedConfigHomes, startupEntries } from "./own-entries.js";
import { resolveAssets } from "../asset-selection/index.js";
import { pruneCache } from "../workspace/packages.js";
import { followImports } from "../imports/local.js";
import { adoptMoved, localOverlay } from "../workspace/overlay.js";
import { openWorkspaceSource } from "../workspace/workspace-source.js";
import {
  type RefreshPolicy,
  type WorkspaceSource,
} from "../workspace/source.js";
import { locked, transact, type Write } from "./transaction.js";
import {
  assertInstalledUntouched,
  linkWrites,
  nativeWrites,
  entryNames,
  stateText,
  treeWrites,
} from "./writes.js";
import { fileText } from "../../shared/files.js";
import type { AssetCatalog } from "../asset-selection/types.js";
import { barndogPaths, localWorkspaceFiles } from "../../config/paths.js";

/** Looks up installed names from state, for checks made outside a sync. */
export async function installedNames(runtime: RuntimeContext) {
  const { home } = runtime;

  const { links, native } = await readState(home);

  return (id: string) => heldName(id, links, native);
}

/**
 * Synchronization overrides for source reads, clash resolution and dry runs;
 * checkpoint runs during transaction application.
 */
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

/**
 * Locks the environment, plans harness updates and applies journaled writes;
 * dry runs return planned events.
 */
export async function synchronize(
  configPath: string | undefined,
  runtime: RuntimeContext,
  override?: Settings,
  options: SyncOptions = {},
): Promise<SyncEvent[]> {
  runtime = { ...runtime, home: resolve(runtime.cwd, runtime.home) };
  const { home } = runtime;

  return locked(runtime, async () => {
    const path = resolve(
      runtime.cwd,
      configPath ?? barndogPaths(home).settings,
    );

    const settings = override ?? (await readSettings(home, path));
    if (!settings) {
      throw new SetupRequiredError();
    }

    assertSupportedConfigHomes(settings.harnesses, runtime);

    const stateFile = barndogPaths(home).state;
    const rawState = await fileText(stateFile);

    const before = await readState(home);
    const { native: oldNative, installed: installedState } = before;

    let selection = selectionState(settings);
    const local = settings.localWorkspace;
    const followNotices =
      local && !options.dryRun
        ? await followImports(
            local.path,
            options.refresh ?? "always",
            runtime,
          ).catch((error: unknown) => [
            `Imported assets weren't checked for updates, because ${localWorkspaceFiles(local.path).sources} couldn't be read: ${friendlyMessage(error)}`,
          ])
        : [];

    const source =
      options.source ??
      openWorkspaceSource(settings, runtime, {
        refresh: options.refresh,
      });

    if (
      !source &&
      (selection.subscriptions.length || selection.individualAssetIds.length)
    ) {
      throw new CliError(
        "Your selection includes assets from a BarnDog server, but this machine isn't connected to one.",
        "barndog init",
      );
    }

    const catalog = source
      ? (options.catalog ?? (await source.catalog()))
      : { assets: [], distributions: [] };

    const overlay = localOverlay(settings, runtime);
    if (overlay) {
      selection = await adoptMoved(
        overlay,
        catalog,
        selection,
        !options.dryRun,
      );
    }

    const invalid: ReadonlyMap<string, string> = source
      ? await source.invalidAssets()
      : new Map();

    let effective = resolveAssets(catalog, selection);
    if (effective.diagnostics.length) {
      throw new CliError(
        `Some selected assets or scopes are no longer available; nothing was changed: ${effective.diagnostics.map((d) => (d.type === "missing-asset" ? d.assetId : `${d.scope.type}/${d.scope.id}`)).join(", ")}`,
        "barndog status",
      );
    }

    const events: SyncEvent[] = [
      ...new Set([
        ...followNotices,
        ...(source?.notices() ?? []),
        ...((await source?.warnings?.()) ?? []),
        ...((await overlay?.warnings?.()) ?? []),
      ]),
    ].map((message) => ({
      type: "notice",
      message,
    }));

    const settled = await settleNames(
      {
        assets: effective.assets,
        invalid,
        state: before,
        savedNames: settings.localNames ?? {},
        resolver:
          options.prompt === false || options.dryRun
            ? undefined
            : (options.resolveClash ?? clashPrompt.resolver),
      },
      runtime,
    );

    const { vanished, localNames, skipped } = settled;
    events.push(...settled.events);
    selection = {
      ...selection,
      disabledAssetIds: [
        ...new Set([
          ...selection.disabledAssetIds,
          ...settled.disabledAssetIds,
        ]),
      ],
    };

    effective = resolveAssets(catalog, selection);

    const staged = await stageAssets({
      assets: effective.assets,
      invalid,
      vanished,
      skipped,
      localNames,
      state: before,
      source,
      harnesses: settings.harnesses,
      runtime,
    });

    const { links: desired, native, trees } = staged;
    events.push(...staged.events);
    native.push(...startupEntries(settings, runtime, { knowledge: !!source }));

    const nativeName = entryNames([
      ...installedState.map((t) => [t.id, basename(t.path)] as const),
      // Still known after being deselected, unlike the effective set below.
      ...catalog.assets.map((a) => [a.id, a.name] as const),
      ...effective.assets.map((e) => [e.asset.id, e.asset.name] as const),
    ]);

    await assertInstalledUntouched(installedState, settings, runtime);
    const installedFolders = await treeWrites(installedState, trees, runtime);
    const links = await linkWrites(
      before.links,
      desired,
      installedFolders.updated,
    );

    const settingsFiles = await nativeWrites(oldNative, native, {
      trees,
      updated: installedFolders.updated,
      nameOf: nativeName,
    });

    events.push(...links.events, ...settingsFiles.events);
    const writes: Write[] = [
      ...installedFolders.writes,
      ...links.writes,
      ...settingsFiles.writes,
      {
        kind: "file",
        path: stateFile,
        before: rawState,
        after: stateText({ links: desired, native, trees }),
      },
    ];

    // Explicit overrides are one-shot delivery inputs, never a change to default preferences.
    if (!configPath) {
      const next = source
        ? withSelection(settings, selection)
        : { ...settings };

      if (Object.keys(localNames).length) {
        next.localNames = localNames;
      } else {
        delete next.localNames;
      }

      writes.push({
        kind: "file",
        path: barndogPaths(home).settings,
        before: await fileText(barndogPaths(home).settings),
        after: settingsText(next),
      });
    }

    if (options.dryRun) {
      return events;
    }

    await transact(runtime, writes, source?.journal, options.checkpoint);
    // Only versions the installed folders were just filled from are worth keeping.
    if (source) {
      for (const key of [source.cacheKey, ...(source.extraCacheKeys ?? [])]) {
        await pruneCache(
          key,
          runtime,
          new Set(trees.map((tree) => dirname(tree.source))),
        ).catch(() => 0);
      }
    }

    return events;
  });
}
