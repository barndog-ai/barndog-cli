import { renderMove } from "../ui/move.js";
import { confirmSharingUrlQuery } from "../ui/mcp.js";
import input from "@inquirer/input";
import { type Command } from "commander";
import { type CommandContext } from "./context.js";
import { type AssetKind } from "../config/selection.js";
import { CliError } from "../errors.js";
import { pickOne } from "../ui/pick.js";
import { promptTheme } from "../ui/theme.js";
import {
  bold,
  clean,
  dim,
  hint,
  json,
  ok,
  ORIGIN_HELP,
  originLabel,
} from "../ui/format.js";
import { assetKinds } from "../features/asset-kinds/index.js";
import { requireArguments } from "./arguments.js";

/** Asks for a value in a terminal, or explains the flag to pass. */
export async function ask(
  context: CommandContext,
  value: string | undefined,
  {
    message,
    flag,
    fallback,
  }: {
    message: string;
    /** The option that supplies the value without a prompt, such as `--as`. */
    flag: string;
    fallback?: string;
  },
): Promise<string> {
  if (value) {
    return value;
  }

  if (!context.mode.interactive) {
    throw new CliError(
      `Add ${flag} <value> to this command, or run it in a terminal to be asked.`,
    );
  }

  return (
    await input({ message, default: fallback, theme: promptTheme })
  ).trim();
}

/** `fork` and `promote`: copies an asset into another scope. */
export function registerSharing(
  command: Command,
  kind: AssetKind,
  context: CommandContext,
) {
  const labels = assetKinds[kind];
  const group = assetKinds[kind].command;

  for (const action of ["fork", "promote"] as const) {
    command
      .command(`${action} [name]`)
      .description(
        action === "fork"
          ? `Copy ${labels.a} into a scope you own, such as your personal space`
          : `Propose ${labels.a} for a team, repository or the organization`,
      )
      .option("--origin <origin>", ORIGIN_HELP)
      .option(
        "--target <origin>",
        "Destination scope, such as me, team/engineering or org",
      )
      .option("--name <newName>", "Name of the new asset")
      .option("--key <key>", "Stable key for exact retries")
      .action(
        async (
          name: string | undefined,
          options: {
            origin?: string;
            target?: string;
            name?: string;
            key?: string;
          },
        ) => {
          let origin = options.origin;
          if (!name) {
            requireArguments(
              context,
              `barndog ${group} ${action} <name> --origin <origin> --target <origin> --name <new-name>`,
            );

            const row = await pickOne(
              `Choose ${labels.a} to ${action}`,
              (await context.searchCatalog(kind)).map((row) => ({
                value: row,
                name: row.name,
                columns: [
                  dim(originLabel(row.origin)),
                  dim(clean(row.version.description)),
                ],
              })),
            );

            name = row.name;
            origin = originLabel(row.origin);
          }

          origin = await ask(context, origin, {
            message: "Current scope",
            flag: "--origin",
          });

          const target = await ask(context, options.target, {
            message: "Destination scope (me, team/<slug>, repo/<slug> or org)",
            flag: "--target",
            fallback: action === "fork" ? "me" : undefined,
          });

          const newName = await ask(context, options.name, {
            message: "New name",
            flag: "--name",
            fallback: name,
          });

          const input = {
            kind,
            name,
            origin,
            target,
            newName,
            key: options.key,
          };

          const outcome =
            action === "fork"
              ? ({
                  outcome: "promoted",
                  promotion: await context.fork(input),
                } as const)
              : await context.promote({
                  ...input,
                  confirmUrlQuery: confirmSharingUrlQuery({
                    interactive: context.mode.interactive,
                    write: context.write,
                    // Promoting a local asset shares a copy, as this does.
                    fix: `barndog local move ${name} --keep-local --to ${target} --allow-url-query`,
                  }),
                });

          if (outcome.outcome === "moved") {
            if (context.mode.json) {
              return context.write(json(outcome.move));
            }

            for (const line of renderMove(outcome.move)) {
              context.write(line);
            }

            return;
          }

          const result = outcome.promotion;
          if (context.mode.json) {
            return context.write(json(result));
          }

          context.write(
            result.changeId
              ? `${ok("✔")} Proposed ${bold(newName)} for ${target}. A reviewer must merge the Suggested Change.`
              : `${ok("✔")} Created ${bold(newName)} in ${target}.`,
          );

          context.write(
            result.changeId
              ? hint(`barndog ${group} changes show ${result.changeId}`)
              : hint(
                  `barndog ${group} install ${newName} --origin ${target === "me" ? "me" : target}`,
                ),
          );
        },
      );
  }
}
