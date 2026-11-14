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
import { withLocalSubscription } from "../workspace/overlay.js";
import { localRepoSource } from "../workspace/repo-source.js";
import { openRepoSource } from "../workspace/workspace-source.js";
import { locked } from "../environment/transaction.js";
import {
  type GitWorkspace,
  type LocalWorkspace,
  type Settings,
  readSettings,
  saveSettings,
  settingsPath,
} from "../../config/settings.js";
import { homedir } from "node:os";
import { detectHarnesses } from "../../harnesses/detect.js";
import type { DetectedHarness, Harness } from "../../harnesses/registry.js";

import { connectionContext } from "../auth/session.js";
import { defined } from "../../shared/lookup.js";
import { CliError } from "../../errors.js";

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
function withoutSource(settings: Settings): Settings {
  const { connection, gitWorkspace, localWorkspace, ...rest } = settings;
  void connection;
  void gitWorkspace;
  void localWorkspace;

  return rest;
}

function applyWorkspace(settings: Settings, chosen: ChosenWorkspace) {
  const previousId = (settings.gitWorkspace ?? settings.localWorkspace)
    ?.workspaceId;

  const next: Settings = {
    ...withoutSource(settings),
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
    let next: Settings = previous
      ? { ...previous, harnesses: selected }
      : { harnesses: selected };

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
      if (model) {
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
    }

    if (options.server) {
      const connection = await connectionContext(options.server, home);
      if (
        hasRemoteSelections(next) &&
        next.connection &&
        (next.connection.server !== connection.server ||
          next.connection.organizationId !== connection.organizationId ||
          next.connection.developerId !== connection.developerId)
      ) {
        throw new CliError(
          "You have assets selected from the current server. Remove them before switching server, organization or developer.",
          "barndog status",
        );
      }

      if (next.gitWorkspace || next.localWorkspace) {
        // Repo asset IDs mean nothing to a server, so those choices can't carry over.
        const { environment, localNames, ...cleared } = withoutSource(next);
        void environment;
        void localNames;
        next = { ...cleared, connection };
      } else {
        next = { ...next, connection };
      }
    }

    if (options.chooseEnvironment && (next.connection || next.gitWorkspace)) {
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
        ...next,
        localWorkspace: options.keepLocal,
      };

      next = withSelection(
        settings,
        withLocalSubscription(selectionState(settings), kept),
      );
    }

    if (next.connection || next.gitWorkspace || next.localWorkspace) {
      next = { ...next, knowledge: next.knowledge ?? true };
    }

    if (options.confirm && !(await options.confirm(next))) {
      return {
        configPath: settingsPath(home),
        harnesses: selected,
        cancelled: true,
      };
    }

    if (options.apply) {
      await options.apply(next);
    } else {
      await saveSettings(next, home);
    }

    return { configPath: settingsPath(home), harnesses: selected };
  });
}
