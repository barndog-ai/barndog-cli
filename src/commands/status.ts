import type { Command } from "commander";
import type { CommandContext } from "./context.js";
import { harnessNames, inventoryHints, renderInventory } from "../ui/assets.js";
import { renderCollaboration } from "../ui/collaboration.js";
import { dim, fields, heading, hint, json, ok, plural } from "../ui/format.js";
import { assetKindList, assetKinds } from "../features/asset-kinds/index.js";

export function registerStatus(program: Command, context: CommandContext) {
  program
    .command("status")
    .description(
      "Show what's installed on this machine and where (inside a working copy, its edits first)",
    )
    .option("--paths", "Show installed folders and configuration files")
    .action(async (options: { paths?: boolean }) => {
      const working = await context.workingStatus();
      const inventory = await context.inventory();
      if (context.mode.json) {
        return context.write(
          json(
            "changes" in working
              ? { workingCopy: working, ...inventory }
              : inventory,
          ),
        );
      }

      if ("changes" in working) {
        for (const line of renderCollaboration(working)) {
          context.write(line);
        }

        context.write("");
      }

      context.write(`${heading("status")}\n`);
      for (const line of fields([
        ["Workspace", inventory.server ?? dim("local only")],
        [
          "Coding tools",
          harnessNames(inventory.harnesses) || dim("none selected"),
        ],
        [
          "Knowledge",
          inventory.server
            ? inventory.knowledge
              ? ok("listed at session start")
              : dim("off")
            : undefined,
        ],
      ])) {
        context.write(line);
      }

      if (inventory.offline) {
        context.write(dim(`\nShowing local state only: ${inventory.offline}`));
      }

      for (const kind of assetKindList) {
        const items = inventory.items.filter((item) => item.kind === kind);
        context.write("");
        if (!items.length) {
          context.write(`${assetKinds[kind].many} ${dim("(0)")}`);
          context.write(
            dim(
              `  None. ${`barndog ${assetKinds[kind].command} install`} to add some.`,
            ),
          );

          continue;
        }

        for (const line of renderInventory(items, {
          heading: assetKinds[kind].many,
          paths: options.paths,
        })) {
          context.write(line);
        }
      }

      const hints = inventoryHints(inventory.items);
      context.write("");
      if (hints.length) {
        for (const line of hints) {
          context.write(line);
        }
      }
      // Without the workspace, BarnDog only knows what is installed, not whether it's current.
      else if (inventory.offline) {
        context.write(
          `${plural(inventory.items.length, "asset")} installed. ${dim("Couldn't check for updates; run barndog sync once the workspace is reachable.")}`,
        );
      } else {
        context.write(
          `${ok("✔")} ${plural(inventory.items.length, "asset")} up to date.` +
            (options.paths ? "" : `  ${hint("barndog status --paths", "Tip")}`),
        );
      }
    });
}
