import {
  onboardingEnvironment,
  selectedEnvironment,
  type ChooseEnvironment,
} from "./environment.js";
import {
  hasRemoteSelections,
  selectionState,
  withSelection,
} from "../../config/environment.js";
import { withLocalSubscription } from "../git-workspace/overlay.js";
import { localRepoSource } from "../git-workspace/source.js";
import { openRepoSource } from "../environment/workspace-source.js";
import { locked } from "../environment/transaction.js";
import type {
  GitWorkspace,
  LocalWorkspace,
  Settings,
  SettingsV2,
} from "../../config/settings.js";
import { homedir } from "node:os";
import { detectHarnesses } from "../../harnesses/detect.js";
import type { DetectedHarness, Harness } from "../../harnesses/registry.js";
import {
  readSettings,
  saveSettings,
  settingsPath,
  upgradeSettings,
} from "../../config/settings.js";

import { connectionContext } from "../skills/remote.js";
import { defined } from "../../shared/lookup.js";

export type HarnessChoice = {
  value: Harness;
  name: string;
  evidence: string | null;
  checked: boolean;
};

/** A repo or folder workspace chosen during setup; they replace any earlier one. */
export type ChosenWorkspace =
  { kind: "git"; git: GitWorkspace } | { kind: "local"; local: LocalWorkspace };

/** Only one source can be active, and API selections mean nothing without cloud. */
function withoutSource(settings: SettingsV2): SettingsV2 {
  const { connection, gitWorkspace, localWorkspace, ...rest } = settings;
  void connection;
  void gitWorkspace;
  void localWorkspace;
  return { ...rest, skills: rest.skills.filter((s) => s.kind === "local") };
}

function applyWorkspace(settings: Settings, chosen: ChosenWorkspace) {
  const upgraded = upgradeSettings(settings);
  const previousId = (upgraded.gitWorkspace ?? upgraded.localWorkspace)
    ?.workspaceId;
  const next: SettingsV2 = {
    ...withoutSource(upgraded),
    ...(chosen.kind === "git"
      ? { gitWorkspace: chosen.git }
      : { localWorkspace: chosen.local }),
  };
  const id =
    chosen.kind === "git" ? chosen.git.workspaceId : chosen.local.workspaceId;
  // Asset IDs are derived from the workspace, so choices can't carry across.
  if (previousId !== id) {
    delete next.environment;
    delete next.localNames;
  }
  return next;
}

export type ChooseHarnesses = (choices: HarnessChoice[]) => Promise<Harness[]>;

/** Resolve saved selections and persist only after the caller supplies an explicit choice. */
export async function initialize(options: {
  home?: string;
  server?: string;
  workspace?: ChosenWorkspace;
  /** A local folder that stays active beside the chosen Git or Cloud workspace. */
  keepLocal?: LocalWorkspace;
  choose: ChooseHarnesses;
  chooseEnvironment?: ChooseEnvironment;
  cwd?: string;
  apply?: (settings: Settings) => Promise<void>;
  confirm?: (settings: Settings) => Promise<boolean>;
  detected?: DetectedHarness[];
}): Promise<{ configPath: string; harnesses: Harness[]; cancelled?: boolean }> {
  const home = options.home ?? homedir();
  return locked(home, async () => {
    const previous = await readSettings(home);
    const detected = options.detected ?? (await detectHarnesses({ home }));
    const choices = detected.map((harness) => ({
      value: harness.id,
      name: harness.name,
      evidence: harness.evidence,
      checked: previous?.harnesses.includes(harness.id) ?? false,
    }));
    const selected = await options.choose(choices);
    let next = previous
      ? { ...previous, harnesses: selected }
      : { version: 1 as const, harnesses: selected, skills: [] };
    if (options.workspace) {
      next = applyWorkspace(next, options.workspace);
      const model =
        next.environment === undefined && options.workspace.kind === "local"
          ? await defined(
              openRepoSource(next, home),
              "A local workspace always has a source",
            ).model()
          : undefined;
      // One developer's folder has nothing to choose between: everything installs.
      if (model)
        next = withSelection(next, {
          subscriptions: [
            {
              scope: { type: "org", id: model.organizationId },
              mode: "all",
              enabled: true,
            },
          ],
          individualAssetIds: [],
          excludedAssetIds: [],
          disabledAssetIds: [],
        });
    }
    if (options.server) {
      const connection = await connectionContext(options.server, home);
      const upgraded = upgradeSettings(next);
      if (
        hasRemoteSelections(upgraded) &&
        upgraded.connection &&
        (upgraded.connection.server !== connection.server ||
          upgraded.connection.organizationId !== connection.organizationId ||
          upgraded.connection.developerId !== connection.developerId)
      )
        throw new Error(
          "Remove API selections before switching server, organization, or developer",
        );
      if (upgraded.gitWorkspace || upgraded.localWorkspace) {
        // Repo asset IDs mean nothing to a server, so those choices can't carry over.
        const { environment, localNames, ...cleared } = withoutSource(upgraded);
        void environment;
        void localNames;
        next = { ...cleared, connection };
      } else next = { ...upgraded, connection };
    }
    if (
      options.chooseEnvironment &&
      next.version === 2 &&
      (next.connection || next.gitWorkspace)
    ) {
      const choices = await onboardingEnvironment(next, home);
      next = selectedEnvironment(
        next,
        choices,
        await options.chooseEnvironment(choices),
      );
    }
    if (options.keepLocal) {
      const kept = await localRepoSource(options.keepLocal, home).model();
      const settings = {
        ...upgradeSettings(next),
        localWorkspace: options.keepLocal,
      };
      next = withSelection(
        settings,
        withLocalSubscription(selectionState(settings), kept),
      );
    }
    if (
      next.version === 2 &&
      (next.connection || next.gitWorkspace || next.localWorkspace)
    ) {
      next = { ...next, knowledge: next.knowledge ?? true };
    }
    if (options.confirm && !(await options.confirm(next))) {
      return {
        configPath: settingsPath(home),
        harnesses: selected,
        cancelled: true,
      };
    }
    if (options.apply) await options.apply(next);
    else await saveSettings(next, home);
    return { configPath: settingsPath(home), harnesses: selected };
  });
}
