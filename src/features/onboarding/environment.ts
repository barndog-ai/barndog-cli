import { z } from "zod";
import { scopeSchema, teamMemberSchema } from "@barndog-ai/api-contract";
import {
  environmentCatalog,
  request,
  type EnvironmentCatalog,
  type ApiScope,
} from "../environment/remote.js";
import { openRepoSource } from "../environment/workspace-source.js";
import {
  selectionState,
  withSelection,
  selectionStateSchema,
} from "../../config/environment.js";
import type { Settings } from "../../config/settings.js";
import type {
  SelectionMode,
  SelectionState,
  Subscription,
} from "../asset-selection/types.js";

/**
 * What setup offers: the catalog, the scopes the developer can use, the teams
 * they belong to and the selection saved by a previous setup, used as defaults.
 */
export type OnboardingChoices = {
  catalog: EnvironmentCatalog;
  scopes: ApiScope[];
  memberTeamIds: string[];
  /** Null when the workspace has no personal scope, as in a Git repo. */
  developerId: string | null;
  firstSetup: boolean;
  previous: SelectionState;
};

/**
 * Gathers what setup offers, from the Git or local workspace as last fetched
 * (without fetching again) or from the server.
 */
export async function onboardingEnvironment(
  settings: Settings,
  home: string,
): Promise<OnboardingChoices> {
  const repo = openRepoSource(settings, home, { refresh: "none" });
  if (repo) {
    const model = await repo.model();

    return {
      catalog: model.catalog,
      scopes: model.scopes,
      // Git has no membership list, so every team is on offer and members choose.
      memberTeamIds: model.scopes
        .filter((scope) => scope.type === "team")
        .map((scope) => scope.id),
      developerId: null,
      firstSetup: settings.environment === undefined,
      previous: selectionState(settings),
    };
  }

  if (!settings.connection) {
    throw new Error("A connected identity is required");
  }

  const { connection, catalog } = await environmentCatalog(
    home,
    settings.connection,
  );

  const scopes = await request(connection, "/v1/scopes", z.array(scopeSchema), {
    home,
  });

  const teams = scopes.filter((scope) => scope.type === "team");
  const memberTeamIds: string[] = [];
  // Bound concurrent requests when using servers with the existing membership API.
  for (let offset = 0; offset < teams.length; offset += 6) {
    const memberships = await Promise.all(
      teams.slice(offset, offset + 6).map(async (team) => {
        const members = await request(
          connection,
          `/v1/teams/${team.id}/members`,
          z.array(teamMemberSchema),
          { home },
        );

        return members.some((member) => member.id === connection.developerId)
          ? team.id
          : undefined;
      }),
    );

    memberTeamIds.push(
      ...memberships.filter((id): id is string => id !== undefined),
    );
  }

  return {
    catalog,
    scopes,
    memberTeamIds,
    developerId: connection.developerId,
    firstSetup: settings.environment === undefined,
    previous: selectionState(settings),
  };
}

export type EnvironmentChoices = OnboardingChoices;

/**
 * Asks the developer which sources and assets to install and returns the new
 * selection; replaced by a fake in tests.
 */
export type ChooseEnvironment = (
  choices: EnvironmentChoices,
) => Promise<SelectionState>;

/**
 * How much of one source to install. `custom` means picked assets, recorded one
 * by one rather than as a subscription.
 */
export type SetupMode = "all" | "recommended" | "custom";

/**
 * One source setup lists (the organization, a team, a repository or the
 * developer's own assets), with what is preselected.
 */
export type SetupSource = {
  scope: { type: "org" | "team" | "repo" | "dev"; id: string };
  label: string;
  assets: EnvironmentChoices["catalog"]["assets"];
  recommendedIds: string[];
  selectedIds: string[];
  checked: boolean;
  mode: SetupMode;
};

/**
 * Setup offers the organization, membership teams, scopes already subscribed to,
 * and the developer's own assets. Whatever is left unchecked is removed.
 */
/**
 * The mode setup offers first for a source: a saved subscription's mode, then
 * custom when individual picks or an optional subscription exist, then all of
 * your own assets or the recommended ones of a shared scope.
 */
function initialMode(
  savedMode: SelectionMode | undefined,
  pickedIndividually: boolean,
  scopeType: string,
): SetupMode {
  if (savedMode === "all" || savedMode === "recommended") {
    return savedMode;
  }

  if (pickedIndividually || savedMode === "optional") {
    return "custom";
  }

  return scopeType === "dev" ? "all" : "recommended";
}

/**
 * Builds setup choices from visible scopes, catalog and previous selections.
 * Saved all/recommended modes are retained; optional subscriptions are
 * presented as custom picks.
 */
export function onboardingSources(choices: EnvironmentChoices): SetupSource[] {
  const { catalog, previous, developerId, memberTeamIds, firstSetup } = choices;
  const subscribed = (scope: { type: string; id: string }) =>
    previous.subscriptions.some(
      (s) => s.scope.type === scope.type && s.scope.id === scope.id,
    );

  const scopes = choices.scopes.filter(
    (
      scope,
    ): scope is ApiScope & {
      type: "org" | "team" | "repo";
    } =>
      scope.type === "org" ||
      (scope.type === "team" &&
        (memberTeamIds.includes(scope.id) || subscribed(scope))) ||
      (scope.type === "repo" && subscribed(scope)),
  );

  const own = choices.scopes.find(
    (scope) => scope.type === "dev" && scope.id === developerId,
  );

  const origins = [
    ...scopes.map((scope) => ({
      scope: { type: scope.type, id: scope.id },
      label: scope.name,
    })),
    ...(developerId
      ? [
          {
            scope: { type: "dev" as const, id: developerId },
            label: own ? `Your assets · ${own.slug}` : "Your personal assets",
          },
        ]
      : []),
  ];

  return origins.map(({ scope, label }) => {
    const distribution = catalog.distributions.find(
      (d) => d.scope.type === scope.type && d.scope.id === scope.id,
    );

    const assets = catalog.assets.filter((asset) =>
      scope.type === "dev"
        ? asset.origin.type === "dev" && asset.origin.id === developerId
        : distribution?.assets.some((entry) => entry.assetId === asset.id),
    );

    const recommendations =
      scope.type === "dev"
        ? catalog.distributions
            .filter((distribution) => distribution.scope.type !== "repo")
            .flatMap((d) => d.assets)
            .filter((entry) => entry.mode === "recommended")
            .map((entry) => entry.assetId)
        : (distribution?.assets
            .filter((entry) => entry.mode === "recommended")
            .map((entry) => entry.assetId) ?? []);

    const recommendedIds = assets
      .filter((a) => recommendations.includes(a.id))
      .map((a) => a.id);

    const saved = previous.subscriptions.find(
      (s) => s.scope.type === scope.type && s.scope.id === scope.id,
    );

    const independent = assets
      .filter((a) => previous.individualAssetIds.includes(a.id))
      .map((a) => a.id);

    const subscribed = saved
      ? (distribution?.assets
          .filter((a) => saved.mode === "all" || a.mode === saved.mode)
          .map((a) => a.assetId) ?? [])
      : [];

    return {
      scope,
      label,
      assets,
      recommendedIds,
      selectedIds: [...new Set([...independent, ...subscribed])],
      checked: Boolean(
        saved ||
        independent.length ||
        (firstSetup &&
          (scope.type === "org" ||
            (scope.type === "team" && memberTeamIds.length === 1))),
      ),
      mode: initialMode(saved?.mode, independent.length > 0, scope.type),
    };
  });
}

export type SourceSelection = {
  source: SetupSource;
  mode: SetupMode;
  assetIds?: string[];
};

/** Setup replaces the whole environment with exactly what was chosen. */
export function selectOnboardingSources(
  selections: SourceSelection[],
): SelectionState {
  const subscriptions: Subscription[] = [];
  const individualAssetIds = new Set<string>();
  for (const { source, mode, assetIds } of selections) {
    if (source.scope.type !== "dev" && mode !== "custom") {
      subscriptions.push({
        scope: { type: source.scope.type, id: source.scope.id },
        mode,
        enabled: true,
      });
    } else {
      const ids = {
        custom: assetIds ?? [],
        recommended: source.recommendedIds,
        all: source.assets.map((a) => a.id),
      }[mode];

      if (ids.some((id) => !source.assets.some((a) => a.id === id))) {
        throw new Error("Selection contains an asset outside this source");
      }

      ids.forEach((id) => individualAssetIds.add(id));
    }
  }

  return {
    subscriptions,
    individualAssetIds: [...individualAssetIds],
    excludedAssetIds: [],
    disabledAssetIds: [],
  };
}

/**
 * The settings with their selection replaced by `selection`, after checking it
 * names only scopes and assets setup offered. Writes nothing.
 */
export function selectedEnvironment(
  settings: Settings,
  choices: EnvironmentChoices,
  selection: SelectionState,
) {
  const parsed = selectionStateSchema.parse(selection);
  if (
    parsed.subscriptions.some(
      (s) =>
        !choices.scopes.some(
          (scope) => scope.type === s.scope.type && scope.id === s.scope.id,
        ),
    ) ||
    parsed.individualAssetIds.some(
      (id) => !choices.catalog.assets.some((asset) => asset.id === id),
    )
  ) {
    throw new Error("Selection contains an unavailable scope or asset");
  }

  if (
    new Set(parsed.subscriptions.map((s) => `${s.scope.type}:${s.scope.id}`))
      .size !== parsed.subscriptions.length
  ) {
    throw new Error("Duplicate scope selection");
  }

  return withSelection(settings, parsed);
}
