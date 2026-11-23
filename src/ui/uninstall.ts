/** `barndog uninstall`: the questions it asks, its plan and what it did. */
import checkbox, { Separator } from "@inquirer/checkbox";
import confirm from "@inquirer/confirm";
import select from "@inquirer/select";

import type { AdoptedAsset } from "../features/adoption/record.js";
import type {
  UninstallOptions,
  UninstallResult,
} from "../features/uninstall/index.js";
import type {
  InstalledAsset,
  McpVariable,
  UninstallSurvey,
} from "../features/uninstall/survey.js";
import { adapters, harnesses } from "../harnesses/registry.js";
import type { RuntimeContext } from "../runtime.js";
import {
  bold,
  checklistPageSize,
  dim,
  hint,
  ok,
  plural,
  table,
  warn,
} from "./format.js";
import { displayPath } from "./output.js";
import { checkboxTheme, promptTheme } from "./theme.js";

/** What the command line already decided; prompts ask only for the rest. */
export type UninstallChoices = {
  keepSetup?: boolean;
  dropAdopted?: boolean;
  removeWorkspace?: boolean;
  force?: boolean;
};

/** The command that removes the CLI itself, once BarnDog's files are gone. */
const REMOVE_CLI = "npm uninstall -g barndog";

const kindLabels: Record<InstalledAsset["kind"], string> = {
  skill: "Skill",
  mcp: "MCP server",
  hook: "Hook",
};

const kindWidth = Math.max(
  ...Object.values(kindLabels).map((label) => label.length),
);

/** `3 Skills, 1 MCP server and 2 Hooks`, leaving out kinds with none. */
function counts(assets: readonly { kind: InstalledAsset["kind"] }[]) {
  const parts = (["skill", "mcp", "hook"] as const).flatMap((kind) => {
    const count = assets.filter((asset) => asset.kind === kind).length;

    return count ? [plural(count, kindLabels[kind])] : [];
  });

  return parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
    : (parts[0] ?? "nothing");
}

/** How each line of the plan starts; details under a line align with its text. */
const STEP = "  • ";

/** Each variable and the MCP servers that read it, one per row. */
const variableRows = (variables: readonly McpVariable[], indent = 2) =>
  table(
    variables.map((variable) => [
      bold(variable.name),
      dim(variable.servers.join(", ")),
    ]),
    { indent, header: ["Variable", "MCP servers"] },
  );

/**
 * Whether there is anything of the developer's to leave or remove. With none,
 * there's no choice to make: uninstall only removes BarnDog's own files.
 */
export const hasAssets = (survey: UninstallSurvey) =>
  survey.installed.length > 0 || survey.adopted.length > 0;

/** Options from the command line alone, for runs that can't prompt. */
export function uninstallOptions(
  survey: UninstallSurvey,
  choices: UninstallChoices & { keepSetup: boolean },
): UninstallOptions {
  return {
    keepSetup: choices.keepSetup,
    restore:
      choices.keepSetup || choices.dropAdopted
        ? []
        : survey.adopted.map((item) => item.key),
    keepWorkspace: !choices.removeWorkspace,
    force: choices.force,
  };
}

const chooseRestored = (adopted: readonly AdoptedAsset[]) =>
  checkbox<string>({
    loop: false,
    message:
      "Put these adopted assets back where they were? Unchecked ones are deleted.",
    pageSize: checklistPageSize(adopted.length + harnesses.length),
    choices: harnesses.flatMap((harness) => {
      const mine = adopted.filter((item) => item.harness === harness);

      return mine.length
        ? [
            new Separator(bold(adapters[harness].name)),
            ...mine.map((item) => ({
              value: item.key,
              checked: true,
              short: item.key,
              name: `${kindLabels[item.kind].padEnd(kindWidth)} ${item.name}`,
            })),
          ]
        : [];
    }),
    theme: checkboxTheme,
  });

/** Asks for each choice the command line left open. */
export async function askUninstall(
  survey: UninstallSurvey,
  choices: UninstallChoices,
  runtime: RuntimeContext,
): Promise<UninstallOptions> {
  const keepSetup =
    choices.keepSetup ??
    (await select<boolean>({
      loop: false,
      message: survey.installed.length
        ? `What should happen to the ${counts(survey.installed)} BarnDog installed?`
        : "What should happen to what BarnDog installed?",
      choices: [
        {
          name: "Leave them in my coding tools",
          value: true,
          description:
            "Skills and Hooks become plain folders in each tool; MCP servers stay as they are.",
        },
        {
          name: "Remove them",
          value: false,
          description: "Adopted assets can go back where they came from.",
        },
      ],
      theme: promptTheme,
    }));

  const restore =
    keepSetup || choices.dropAdopted || !survey.adopted.length
      ? []
      : await chooseRestored(survey.adopted);

  const workspace = survey.workspace;
  const keepWorkspace =
    !choices.removeWorkspace &&
    (!workspace ||
      (await confirm({
        message: `Keep your local workspace folder, ${displayPath(workspace, runtime)}?`,
        default: true,
        theme: promptTheme,
      })));

  return { keepSetup, restore, keepWorkspace, force: choices.force };
}

/** What uninstalling with `options` will do. */
export function renderUninstallPlan(
  survey: UninstallSurvey,
  options: UninstallOptions,
  runtime: RuntimeContext,
): string[] {
  const root = displayPath(survey.root, runtime);
  const lines: string[] = hasAssets(survey)
    ? []
    : [
        "BarnDog installed no Skills, MCP servers or Hooks in your coding tools, so there's nothing of yours to keep or remove.",
        "",
      ];

  lines.push(bold("BarnDog will"));
  const step = (text: string) => lines.push(`${STEP}${text}`);

  if (survey.installed.length) {
    step(
      options.keepSetup
        ? `leave ${counts(survey.installed)} in your coding tools, as plain files of their own`
        : `remove ${counts(survey.installed)} from your coding tools`,
    );
  }

  if (options.keepSetup && survey.variables.length) {
    step(
      warn(
        "leave it to you to keep these variables set; your MCP servers read them from your environment:",
      ),
    );

    lines.push(...variableRows(survey.variables, STEP.length));
  }

  step("remove its own scripts and registrations from your tools");

  const restored = survey.adopted.filter((item) =>
    options.restore.includes(item.key),
  );

  const dropped = options.keepSetup
    ? []
    : survey.adopted.filter((item) => !options.restore.includes(item.key));

  if (restored.length) {
    step(
      `put back ${plural(restored.length, "adopted asset")} where ${restored.length === 1 ? "it" : "they"} came from`,
    );
  }

  if (dropped.length) {
    step(
      warn(
        `delete ${plural(dropped.length, "adopted asset")} for good: ${dropped.map((item) => item.key).join(", ")}`,
      ),
    );
  }

  if (survey.servers.length) {
    step(`sign out of ${survey.servers.join(", ")}`);
  }

  const workspace = survey.workspace;
  step(
    workspace && options.keepWorkspace
      ? `delete ${root}, except your local workspace in ${displayPath(workspace, runtime)}`
      : `delete ${root}`,
  );

  return lines;
}

export function confirmUninstall(): Promise<boolean> {
  return confirm({
    message: "Uninstall BarnDog?",
    default: false,
    theme: promptTheme,
  });
}

/** What the uninstall did, and the last step: removing the CLI. */
export function renderUninstall(
  result: UninstallResult,
  runtime: RuntimeContext,
): string[] {
  const lines = [`${ok("✔")} BarnDog's files are gone from this machine.`, ""];

  if (result.left.length) {
    lines.push(bold("Left in your coding tools"));
    lines.push(
      ...table(
        result.left.map((asset) => [
          adapters[asset.harness].name,
          dim(kindLabels[asset.kind]),
          bold(asset.name),
          dim(displayPath(asset.path, runtime)),
        ]),
      ),
    );

    lines.push("");
  }

  if (result.variables.length) {
    lines.push(
      warn(
        "Your MCP servers read these variables from your environment. Without BarnDog, keeping them set is up to you:",
      ),
      ...variableRows(result.variables),
      "",
    );
  }

  if (result.removed.length) {
    lines.push(
      result.keptSetup
        ? "Removed BarnDog's own scripts and registrations from your coding tools."
        : "Removed everything BarnDog installed from your coding tools.",
    );
  }

  if (result.restored.length) {
    lines.push(
      `Put back ${result.restored.map((item) => bold(item.key)).join(", ")}.`,
    );
  }

  for (const { server, revoked } of result.signedOut) {
    lines.push(
      revoked
        ? `Signed out of ${server}.`
        : warn(
            `Signed out of ${server} here, but the server couldn't be told; that session ends when it expires.`,
          ),
    );
  }

  lines.push(
    result.keptWorkspace
      ? `Deleted ${displayPath(result.root, runtime)}, except your local workspace in ${displayPath(result.keptWorkspace, runtime)}.`
      : `Deleted ${displayPath(result.root, runtime)}.`,
  );

  lines.push("", hint(REMOVE_CLI, "Next"));

  return lines;
}
