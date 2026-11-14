import { z } from "zod";
import type { Settings } from "./settings.js";
import type { SelectionState } from "../features/asset-selection/types.js";

const id = z.uuidv4().transform((value) => value.toLowerCase());

export const selectionStateSchema = z
  .object({
    subscriptions: z.array(
      z
        .object({
          scope: z.object({ type: z.enum(["org", "team", "repo"]), id }),
          mode: z.enum(["recommended", "optional", "all"]),
          enabled: z.boolean(),
        })
        .strict(),
    ),
    individualAssetIds: z.array(id),
    excludedAssetIds: z.array(id),
    disabledAssetIds: z.array(id),
  })
  .strict();

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
