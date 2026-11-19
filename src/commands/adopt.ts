import type { Command } from "commander";

import { CliError } from "../errors.js";
import {
  offerAdoption,
  renderAdoption,
  renderAdoptions,
  renderScan,
  renderUndo,
} from "../ui/adopt.js";
import { dim, json } from "../ui/format.js";
import type { CommandContext } from "./context.js";

type AdoptOptions = { dryRun?: boolean; all?: boolean; only?: string[] };

/** Registers `adopt`, `adopt list` and `adopt undo`. */
export function registerAdopt(program: Command, context: CommandContext) {
  const adopt = program
    .command("adopt")
    .description(
      "Let BarnDog manage the Skills, MCP servers and Hooks your coding tools already have",
    )
    .option("--dry-run", "Show what can be adopted without changing anything")
    .option("--all", "Adopt everything that can be adopted")
    .option(
      "--only <assets...>",
      "Adopt these, named tool/kind/name as --dry-run lists them",
    )
    .action(async (options: AdoptOptions) => {
      if (options.all && options.only) {
        throw new CliError(
          "--all and --only can't be combined. Choose one.",
          "barndog adopt --help",
        );
      }

      const scan = await context.scanNative();
      if (options.dryRun) {
        if (context.mode.json) {
          return context.write(json(scan));
        }

        for (const line of renderScan(scan, context.runtime)) {
          context.write(line);
        }

        return;
      }

      const keys = options.all
        ? scan.assets.map((asset) => asset.key)
        : options.only;

      if (!keys) {
        if (!context.mode.interactive) {
          throw new CliError(
            "Choose what to adopt with --only <tool/kind/name...> or --all; --dry-run lists the names.",
            "barndog adopt --dry-run",
          );
        }

        if (!scan.assets.length) {
          for (const line of renderScan(scan, context.runtime)) {
            context.write(line);
          }

          return;
        }

        await offerAdoption(scan, {
          adoptNative: context.adoptNative,
          write: context.write,
          runtime: context.runtime,
        });

        return;
      }

      if (!keys.length) {
        return context.write(
          context.mode.json ? json({ adopted: [] }) : dim("Nothing to adopt."),
        );
      }

      // Without a terminal nothing is kept; the notes say which variables to set.
      const result = await context.adoptNative(keys, []);
      if (context.mode.json) {
        return context.write(json(result));
      }

      for (const line of renderAdoption(result, context.runtime)) {
        context.write(line);
      }
    });

  adopt
    .command("list")
    .description("List adoptions on this machine and what each took over")
    .action(async () => {
      const list = await context.listAdoptions();
      if (context.mode.json) {
        return context.write(json(list));
      }

      for (const line of renderAdoptions(list)) {
        context.write(line);
      }
    });

  adopt
    .command("undo [id]")
    .description(
      "Put adopted assets back in their coding tools (the newest adoption by default)",
    )
    .option(
      "--only <assets...>",
      "Put back only these, named tool/kind/name as adopt list shows them",
    )
    .option("--force", "Undo even if BarnDog's copy was edited since")
    .action(async (id: string | undefined, _: unknown, command: Command) => {
      // Commander gives `--only` to `adopt`, which declares it too, wherever
      // it appears; positional options would change how every command parses.
      const options = command.optsWithGlobals<{
        only?: string[];
        force?: boolean;
      }>();

      const result = await context.undoAdoption({
        id,
        only: options.only,
        force: options.force,
      });

      if (context.mode.json) {
        return context.write(json(result));
      }

      for (const line of renderUndo(result, context.runtime)) {
        context.write(line);
      }
    });
}
