import type { Command } from "commander";

import {
  bold,
  dim,
  heading,
  json,
  ok,
  plural,
  table,
  warn,
} from "../ui/format.js";
import { chooseKeepLocal, pickLocalAssets, renderMove } from "../ui/move.js";
import { confirmSharingUrlQuery } from "../ui/mcp.js";
import { CliError } from "../errors.js";
import type { CommandContext } from "./context.js";
import type { MigrationRow } from "../features/migration/migrate.js";

const migrationActionStyles: Record<
  MigrationRow["action"],
  (text: string) => string
> = {
  publish: ok,
  exists: dim,
  invalid: warn,
  "missing-scope": warn,
};

/**
 * Registers workspace validation, local asset movement and migration commands
 * using the supplied services.
 */
export function registerWorkspace(program: Command, context: CommandContext) {
  program
    .command("validate [directory]")
    .description("Check a BarnDog workspace folder, for example in a repo's CI")
    .action(async (directory?: string) => {
      const result = await context.validateFolder(directory ?? ".");
      if (context.mode.json) {
        return context.write(json(result));
      }

      context.write(
        `${ok("✔")} ${bold(result.workspace)} is valid · ${plural(result.assets, "asset")}, ${plural(result.knowledge, "knowledge document")}`,
      );
    });

  const local = program
    .command("local")
    .description("See and share the assets kept in this machine's folder");

  local
    .command("list")
    .description("List the assets kept in this machine's folder")
    .action(async () => {
      const result = await context.listLocalAssets();
      if (context.mode.json) {
        return context.write(json(result));
      }

      context.write(dim(result.folder));
      if (!result.assets.length) {
        return context.write(dim("No local assets."));
      }

      for (const line of table(
        result.assets.map((asset) => [
          bold(asset.name),
          dim(asset.kind),
          asset.state === "invalid" ? warn(asset.state) : asset.state,
          dim(asset.path),
          asset.movingTo ? dim(`to ${asset.movingTo}`) : "",
        ]),
        { header: ["Name", "Kind", "State", "Path", ""] },
      )) {
        context.write(line);
      }
    });

  local
    .command("move [names...]")
    .description("Move local assets into your Git or Cloud workspace")
    .option("--all", "Move every local asset that isn't already moving")
    .option(
      "--keep-local",
      "Share a copy and keep the local assets as separate ones",
    )
    .option(
      "--no-keep-local",
      "Make the shared copy the only one; the local copy is removed once it exists",
    )
    .option(
      "--to <origin>",
      "Destination, such as me, org or team/web. Defaults to me in cloud, org in Git",
    )
    .option("--as <name>", "New name, for moving one asset whose name is taken")
    .option(
      "--repo <url>",
      "Send to this Git repo; this machine stays as it is",
    )
    .option(
      "--server <url>",
      "Send to this Cloud Workspace; this machine stays as it is",
    )
    .option(
      "--allow-url-query",
      "Share MCP servers whose URL has query parameters without asking",
    )
    .addHelpText(
      "after",
      `
Without names, a terminal lists your local assets to pick from; elsewhere, name them or pass --all.

It then asks whether to move them or keep separate local copies; --keep-local or --no-keep-local answers without asking.
  Move: the shared copy becomes the only one. Once it exists, the next sync installs it and removes the local copy.
        A move into a Git repo with assets in it waits for its pull request: until it merges, local list shows
        the asset as moving and the local copy stays in use. A local copy edited before then stays as a separate asset.
  Keep: a copy is shared and the local asset stays. When both have the same name, sync asks which to rename.
With --repo or --server this machine stays as it is, so the assets are always copied.`,
    )
    .action(
      async (
        names: string[],
        options: {
          all?: boolean;
          keepLocal?: boolean;
          to?: string;
          as?: string;
          repo?: string;
          server?: string;
          allowUrlQuery?: boolean;
        },
      ) => {
        const chosen = await chooseNames(names, options.all);
        // --repo and --server send a copy and leave this machine as it is.
        const oneOff = Boolean(options.repo || options.server);
        const keepLocal =
          options.keepLocal ?? (oneOff || (await askKeepLocal(chosen?.length)));

        const result = await context.moveLocalAssets({
          names: chosen,
          keepLocal,
          to: options.to,
          as: options.as,
          repo: options.repo,
          server: options.server,
          confirmUrlQuery: confirmSharingUrlQuery({
            interactive: context.mode.interactive,
            allowed: options.allowUrlQuery,
            write: context.write,
            fix: [
              "barndog local move",
              chosen?.join(" ") ?? "--all",
              keepLocal ? "--keep-local" : "--no-keep-local",
              ...Object.entries({
                to: options.to,
                as: options.as,
                repo: options.repo,
                server: options.server,
              }).flatMap(([flag, value]) =>
                value ? [`--${flag} ${value}`] : [],
              ),
              "--allow-url-query",
            ].join(" "),
          }),
        });

        if (context.mode.json) {
          return context.write(json(result));
        }

        for (const line of renderMove(result)) {
          context.write(line);
        }
      },
    );

  /** The names to move; undefined means every local asset not already moving. */
  async function chooseNames(names: string[], all: boolean | undefined) {
    if (all && names.length) {
      throw new CliError(
        "Name the assets to move or pass --all, not both.",
        "barndog local move --help",
      );
    }

    if (all || names.length) {
      return all ? undefined : names;
    }

    if (!context.mode.interactive) {
      throw new CliError(
        "Name the local assets to move, or pass --all.",
        "barndog local move <names...> --keep-local, or barndog local move --all --no-keep-local",
      );
    }

    return pickLocalAssets(await context.listLocalAssets());
  }

  async function askKeepLocal(count: number | undefined) {
    if (!context.mode.interactive) {
      throw new CliError(
        "Say whether to keep separate local copies: --keep-local keeps them, --no-keep-local makes the shared copy the only one.",
        "barndog local move --help",
      );
    }

    return chooseKeepLocal(count ?? 2);
  }

  program
    .command("migrate")
    .description(
      "Move a Git repo or local workspace to a BarnDog Cloud Workspace",
    )
    .requiredOption("--to <server>", "Cloud or self-hosted server URL")
    .option("--dry-run", "Show what would move without changing anything")
    .action(async (options: { to: string; dryRun?: boolean }) => {
      const result = await context.migrate({
        server: options.to,
        dryRun: options.dryRun,
      });

      if (context.mode.json) {
        return context.write(json(result));
      }

      context.write(
        `\n${heading(options.dryRun ? "migrate --dry-run" : "migrate")}\n`,
      );

      for (const line of table(
        result.rows.map((row) => [
          migrationActionStyles[row.action](row.action),
          dim(row.kind),
          bold(row.name),
          row.origin,
          dim(row.detail ?? ""),
        ]),
        { header: ["Action", "Kind", "Name", "Origin", ""] },
      )) {
        context.write(line);
      }

      context.write("");
      context.write(
        result.migrated
          ? `${ok("✔")} This machine now uses ${result.server}. Only current content moved; older versions stay in your repo.`
          : dim("Nothing was changed."),
      );
    });
}
