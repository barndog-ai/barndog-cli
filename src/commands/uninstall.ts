import { Option, type Command } from "commander";

import { CliError } from "../errors.js";
import { json } from "../ui/format.js";
import {
  askUninstall,
  confirmUninstall,
  renderUninstall,
  renderUninstallPlan,
  uninstallOptions,
  type UninstallChoices,
} from "../ui/uninstall.js";
import type { CommandContext } from "./context.js";

type UninstallFlags = {
  keepSetup?: boolean;
  removeAll?: boolean;
  dropAdopted?: boolean;
  removeWorkspace?: boolean;
  force?: boolean;
  dryRun?: boolean;
};

/** Registers `uninstall`. */
export function registerUninstall(program: Command, context: CommandContext) {
  program
    .command("uninstall")
    .description(
      "Remove BarnDog from this machine, leaving your Skills, MCP servers and Hooks in your coding tools or removing them too",
    )
    .addOption(
      new Option(
        "--keep-setup",
        "Leave Skills, MCP servers and Hooks in your coding tools as plain files",
      ).conflicts("removeAll"),
    )
    .option(
      "--remove-all",
      "Remove every Skill, MCP server and Hook BarnDog installed",
    )
    .option(
      "--drop-adopted",
      "With --remove-all, delete adopted assets instead of putting them back",
    )
    .option(
      "--remove-workspace",
      "Delete the local workspace folder too, when it is inside ~/.barndog",
    )
    .option(
      "--force",
      "Put adopted assets back even if BarnDog's copy was edited since",
    )
    .option("--dry-run", "Show what would happen without changing anything")
    .action(async (flags: UninstallFlags) => {
      const survey = await context.uninstallSurvey();
      const choices: UninstallChoices = {
        keepSetup: flags.keepSetup || (flags.removeAll ? false : undefined),
        dropAdopted: flags.dropAdopted,
        removeWorkspace: flags.removeWorkspace,
        force: flags.force,
      };

      let options;
      if (context.mode.interactive) {
        options = await askUninstall(survey, choices, context.runtime);
      } else if (choices.keepSetup === undefined) {
        throw new CliError(
          "Choose whether to keep your Skills, MCP servers and Hooks: --keep-setup leaves them in your coding tools, --remove-all removes them.",
          "barndog uninstall --keep-setup",
        );
      } else {
        options = uninstallOptions(survey, {
          ...choices,
          keepSetup: choices.keepSetup,
        });
      }

      if (flags.dryRun) {
        if (context.mode.json) {
          return context.write(json({ survey, options }));
        }

        for (const line of renderUninstallPlan(
          survey,
          options,
          context.runtime,
        )) {
          context.write(line);
        }

        return;
      }

      if (context.mode.interactive) {
        for (const line of renderUninstallPlan(
          survey,
          options,
          context.runtime,
        )) {
          context.write(line);
        }

        if (!(await confirmUninstall())) {
          return context.write("Nothing was changed.");
        }
      }

      const result = await context.uninstall(options);
      if (context.mode.json) {
        return context.write(json(result));
      }

      for (const line of renderUninstall(result, context.runtime)) {
        context.write(line);
      }
    });
}
