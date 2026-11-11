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
import type { MigrationRow } from "../features/git-workspace/migrate.js";
import type { MoveResult } from "../features/git-workspace/move.js";
import { renderMove } from "../ui/move.js";
import type { CommandContext } from "./context.js";

export function registerWorkspace(program: Command, context: CommandContext) {
  program
    .command("validate [directory]")
    .description("Check a BarnDog workspace folder, for example in a repo's CI")
    .action(async (directory?: string) => {
      const result = (await context.capability("validate", { directory })) as {
        workspace: string;
        assets: number;
        knowledge: number;
      };
      if (context.mode.json) return context.write(json(result));
      context.write(
        `${ok("✔")} ${bold(result.workspace)} is valid · ${plural(result.assets, "asset")}, ${plural(result.knowledge, "knowledge document")}`,
      );
    });
  const local = program
    .command("local")
    .description("See and share the assets kept in this machine's folder");
  local
    .command("list")
    .description("List local assets and whether they've been moved")
    .action(async () => {
      const result = (await context.capability("local-list", {})) as {
        folder: string;
        assets: { kind: string; name: string; path: string; state: string }[];
      };
      if (context.mode.json) return context.write(json(result));
      context.write(dim(result.folder));
      if (!result.assets.length) return context.write(dim("No local assets."));
      for (const line of table(
        result.assets.map((asset) => [
          bold(asset.name),
          dim(asset.kind),
          asset.state === "invalid" ? warn(asset.state) : asset.state,
          dim(asset.path),
        ]),
        { header: ["Name", "Kind", "State", "Path"] },
      ))
        context.write(line);
    });
  local
    .command("move [names...]")
    .description("Copy local assets into your Git or Cloud workspace")
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
    .action(
      async (
        names: string[],
        options: { to?: string; as?: string; repo?: string; server?: string },
      ) => {
        const result = (await context.capability("local-move", {
          names,
          to: options.to,
          as: options.as,
          repo: options.repo,
          server: options.server,
        })) as MoveResult;
        if (context.mode.json) return context.write(json(result));
        for (const line of renderMove(result)) context.write(line);
      },
    );
  program
    .command("migrate")
    .description(
      "Move a Git repo or local workspace to a BarnDog Cloud Workspace",
    )
    .requiredOption("--to <server>", "Cloud or self-hosted server URL")
    .option("--dry-run", "Show what would move without changing anything")
    .action(async (options: { to: string; dryRun?: boolean }) => {
      const result = (await context.capability("migrate", {
        server: options.to,
        dryRun: options.dryRun,
      })) as {
        server: string;
        dryRun: boolean;
        rows: MigrationRow[];
        migrated: boolean;
      };
      if (context.mode.json) return context.write(json(result));
      context.write(
        `\n${heading(options.dryRun ? "migrate --dry-run" : "migrate")}\n`,
      );
      for (const line of table(
        result.rows.map((row) => [
          row.action === "publish"
            ? ok(row.action)
            : row.action === "exists"
              ? dim(row.action)
              : warn(row.action),
          dim(row.kind),
          bold(row.name),
          row.origin,
          dim(row.detail ?? ""),
        ]),
        { header: ["Action", "Kind", "Name", "Origin", ""] },
      ))
        context.write(line);
      context.write("");
      context.write(
        result.migrated
          ? `${ok("✔")} This machine now uses ${result.server}. Only current content moved; older versions stay in your repo.`
          : dim("Nothing was changed."),
      );
    });
}
