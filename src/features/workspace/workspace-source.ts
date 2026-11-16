import type { RuntimeContext } from "../../runtime.js";
import type { Settings } from "../../config/settings.js";
import { cloudSource } from "./cloud-source.js";
import type { SourceOptions, WorkspaceSource } from "./source.js";
import { localOverlay, withOverlay } from "./overlay.js";
import {
  gitRepoSource,
  localRepoSource,
  type RepoSource,
} from "./repo-source.js";

/**
 * Builds a lazy Git or local-folder source from settings; returns undefined for
 * a cloud-only setup.
 */
export function openRepoSource(
  settings: Settings,
  runtime: RuntimeContext,
  options: SourceOptions = {},
): RepoSource | undefined {
  if (settings.gitWorkspace) {
    return gitRepoSource(settings.gitWorkspace, runtime, options);
  }

  if (settings.localWorkspace && !settings.connection) {
    return localRepoSource(settings.localWorkspace, runtime);
  }

  return undefined;
}

/**
 * Builds the configured primary source and merges a retained local overlay when
 * present.
 */
export function openWorkspaceSource(
  settings: Settings,
  runtime: RuntimeContext,
  options: SourceOptions = {},
): WorkspaceSource | undefined {
  const primary = settings.connection
    ? cloudSource(settings.connection, runtime)
    : openRepoSource(settings, runtime, options);

  const overlay = localOverlay(settings, runtime);

  return primary && overlay ? withOverlay(primary, overlay) : primary;
}
