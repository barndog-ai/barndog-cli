import type { Settings } from "../../config/settings.js";
import { cloudSource } from "./cloud-source.js";
import type { WorkspaceSource } from "./source.js";
import { localOverlay, withOverlay } from "../git-workspace/overlay.js";
import {
  gitRepoSource,
  localRepoSource,
  type RepoSource,
} from "../git-workspace/source.js";

/** always: fetch now. auto: reuse a recent fetch. none: read only what's on disk. */
export type RefreshPolicy = "always" | "auto" | "none";

export type SourceOptions = {
  refresh?: RefreshPolicy;
};

/**
 * Builds a lazy Git or local-folder source from settings; returns undefined for
 * a cloud-only setup.
 */
export function openRepoSource(
  settings: Settings,
  home: string,
  options: SourceOptions = {},
): RepoSource | undefined {
  if (settings.gitWorkspace) {
    return gitRepoSource(settings.gitWorkspace, home, options);
  }

  if (settings.localWorkspace && !settings.connection) {
    return localRepoSource(settings.localWorkspace, home);
  }

  return undefined;
}

/**
 * Builds the configured primary source and merges a retained local overlay when
 * present.
 */
export function openWorkspaceSource(
  settings: Settings,
  home: string,
  options: SourceOptions = {},
): WorkspaceSource | undefined {
  const primary = settings.connection
    ? cloudSource(settings.connection, home)
    : openRepoSource(settings, home, options);

  const overlay = localOverlay(settings, home);

  return primary && overlay ? withOverlay(primary, overlay) : primary;
}
