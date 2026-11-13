import checkbox from "@inquirer/checkbox";
import select from "@inquirer/select";
import { checkboxTheme, promptTheme } from "./theme.js";
import { bold, dim, visibleWidth } from "./format.js";
import {
  onboardingSources,
  selectOnboardingSources,
  type ChooseEnvironment,
  type SetupMode,
  type SetupSource,
  type SourceSelection,
} from "../features/onboarding/environment.js";

const kindLabel: Record<SetupSource["scope"]["type"], string> = {
  org: "organization",
  team: "team",
  repo: "repository",
  dev: "personal",
};

/** Aligned name, type and asset-count columns for the source checklist. */
function sourceLabels(
  sources: SetupSource[],
  describe: (source: SetupSource) => { name: string; detail: string },
) {
  const rows = sources.map(describe);
  const width = Math.max(...rows.map((row) => visibleWidth(row.name)));
  const detailWidth = Math.max(...rows.map((row) => visibleWidth(row.detail)));
  return sources.map((source) => {
    const row = describe(source);
    return `${row.name.padEnd(width)}  ${dim(row.detail.padEnd(detailWidth))}  ${dim(`${source.assets.length} ${source.assets.length === 1 ? "asset" : "assets"}`)}${source.scope.type === "org" ? `  ${dim("· suggested")}` : ""}`;
  });
}

export function environmentChooser(
  write: (text: string) => void,
): ChooseEnvironment {
  return async (choices) => {
    const sources = onboardingSources(choices);
    const git = choices.developerId === null;
    write("");
    write(bold("Shared assets"));
    if (git && sources.every((source) => !source.assets.length)) {
      write(
        "This repo has no assets yet. They'll install here at your next sync.",
      );
      write(
        dim("Add them with barndog skills create, or commit them to the repo."),
      );
      return selectOnboardingSources(
        sources
          .filter((source) => source.checked)
          .map((source) => ({ source, mode: source.mode })),
      );
    }
    const repoName = sources.find((s) => s.scope.type === "org")?.label ?? "";
    const folder = (source: SetupSource) => {
      if (source.scope.type === "org") return "org/";
      const slug = choices.scopes.find((s) => s.id === source.scope.id)?.slug;
      return `${source.scope.type === "team" ? "teams" : "repos"}/${slug}/`;
    };
    // A Git repo with only shared assets has nothing to choose between.
    const single = git && sources.length === 1;
    const titled = (source: SetupSource) =>
      !git ? source.label : single ? repoName : folder(source);
    if (!git && !choices.catalog.assets.length)
      write(
        "No published assets are available yet. Add assets in the web workspace when you're ready.",
      );
    if (!single)
      write(
        "Choose where this machine's Skills, MCP servers and Hooks come from. Anything you leave unchecked is removed.",
      );
    if (
      choices.developerId !== null &&
      choices.firstSetup &&
      choices.memberTeamIds.length === 1
    )
      write(dim("Your team is preselected."));
    if (choices.developerId !== null && choices.memberTeamIds.length > 1)
      write(dim("You belong to several teams; choose the ones you work with."));
    if (!single)
      write(
        dim(
          `Later: barndog sets switch team/<slug> or repo/<slug>, barndog sets install repo/<slug>.`,
        ),
      );
    if (!single) write("");
    const labels = sourceLabels(sources, (source) =>
      git
        ? {
            name: source.scope.type === "org" ? "Everyone" : source.label,
            detail: folder(source),
          }
        : { name: source.label, detail: kindLabel[source.scope.type] },
    );
    const chosen = single
      ? sources
      : await checkbox({
          loop: false,
          message: git
            ? `What should this machine install from ${repoName}?`
            : "Which sources would you like to include?",
          choices: sources.map((source, index) => ({
            name: labels[index] ?? titled(source),
            short: titled(source),
            value: source,
            checked: source.checked,
          })),
          pageSize: 10,
          theme: checkboxTheme,
        });
    const selections: SourceSelection[] = [];
    for (const source of chosen) {
      write("");
      const mode = await select<SetupMode>({
        loop: false,
        message: `What to include from ${titled(source)}?`,
        default: source.mode,
        choices: [
          { name: `All assets (${source.assets.length})`, value: "all" },
          {
            name: `Recommended only (${source.recommendedIds.length})`,
            value: "recommended",
          },
          { name: "Custom — choose assets", value: "custom" },
        ],
        theme: promptTheme,
      });
      let assetIds: string[] | undefined;
      if (mode === "custom") {
        const width = Math.max(0, ...source.assets.map((a) => a.name.length));
        if (source.assets.length) write("");
        assetIds = source.assets.length
          ? await checkbox({
              loop: false,
              message: `Choose assets from ${titled(source)}`,
              choices: source.assets.map((asset) => ({
                name: `${asset.name.padEnd(width)}  ${dim(asset.kind)}`,
                short: asset.name,
                value: asset.id,
                checked: source.selectedIds.includes(asset.id),
              })),
              pageSize: 10,
              theme: checkboxTheme,
            })
          : [];
      }
      if (!source.assets.length)
        write(dim(`No published assets in ${titled(source)} yet.`));
      if (
        source.scope.type === "dev" &&
        mode === "recommended" &&
        !source.recommendedIds.length
      )
        write(
          dim(
            "None of your personal assets are marked recommended in an organization or team set.",
          ),
        );
      selections.push({ source, mode, assetIds });
    }
    return selectOnboardingSources(selections);
  };
}
