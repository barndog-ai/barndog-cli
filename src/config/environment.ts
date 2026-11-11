import { z } from "zod";
import type { Settings, SettingsV2 } from "./settings.js";
import { upgradeSettings } from "./settings.js";
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

export function selectionState(settings: Settings): SelectionState {
  const next = upgradeSettings(settings);
  return (
    next.environment ?? {
      subscriptions: [],
      individualAssetIds: next.skills
        .filter((s) => s.kind === "api")
        .map((s) => s.id),
      excludedAssetIds: [],
      disabledAssetIds: next.skills
        .filter((s) => s.kind === "api" && !s.enabled)
        .map((s) => s.id),
    }
  );
}

export function withSelection(
  settings: Settings,
  environment: SelectionState,
): SettingsV2 {
  return {
    ...upgradeSettings(settings),
    skills: upgradeSettings(settings).skills.filter((s) => s.kind === "local"),
    environment: selectionStateSchema.parse(environment),
  };
}

export function hasRemoteSelections(settings: Settings): boolean {
  const state = selectionState(settings);
  return !!(state.subscriptions.length || state.individualAssetIds.length);
}
