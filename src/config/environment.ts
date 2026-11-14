import type { Settings } from "./settings.js";
import { selectionStateSchema, type SelectionState } from "./selection.js";

/**
 * Reads selections from settings, returning empty lists when no environment has
 * been saved.
 */
export function selectionState(settings: Settings): SelectionState {
  return (
    settings.environment ?? {
      subscriptions: [],
      individualAssetIds: [],
      excludedAssetIds: [],
      disabledAssetIds: [],
    }
  );
}

export function withSelection(
  settings: Settings,
  environment: SelectionState,
): Settings {
  return {
    ...settings,
    environment: selectionStateSchema.parse(environment),
  };
}

/**
 * Checks whether settings contain subscriptions or individually selected
 * assets, including disabled selections.
 */
export function hasRemoteSelections(settings: Settings): boolean {
  const state = selectionState(settings);

  return !!(state.subscriptions.length || state.individualAssetIds.length);
}
