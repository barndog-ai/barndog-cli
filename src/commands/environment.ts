import { renderMove } from "../ui/move.js";
import input from "@inquirer/input";
import { Option, type Command } from "commander";
import type { CommandContext } from "./context.js";
import type { AssetKind } from "../features/asset-selection/types.js";
import type { InventoryItem } from "../features/inventory/index.js";
import { prefixedName } from "../features/environment/names.js";
import { CliError, friendlyMessage } from "../errors.js";
import {
  assetListOptions,
  pageOptions,
  filterAssets,
  type ListOptions,
} from "../ui/asset-list.js";
import {
  assetListing,
  inventoryHints,
  kindLabels,
  type ListFilter,
  renderCatalog,
  renderInventory,
} from "../ui/assets.js";
import { runSetInstall } from "../ui/scope-install.js";
import { runSelection } from "../ui/selection.js";
import { pickMany, pickOne, type PickChoice } from "../ui/pick.js";
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
  section,
  table,
} from "../ui/format.js";

export { runSelection } from "../ui/selection.js";

type AssetAction = "install" | "remove" | "enable" | "disable";

/** Asks for a value in a terminal, or explains the flag to pass. */
export async function ask(
  context: CommandContext,
  value: string | undefined,
  message: string,
  flag: string,
  fallback?: string,
): Promise<string> {
  if (value) return value;
  if (!context.mode.interactive)
    throw new CliError(
      `Add ${flag} <value> to this command, or run it in a terminal to be asked.`,
    );
  return (
    await input({ message, default: fallback, theme: promptTheme })
  ).trim();
}

function requireArguments(context: CommandContext, usage: string) {
  if (!context.mode.interactive)
    throw new CliError(
      "Name the asset to act on, or run this in a terminal to choose from a list.",
      usage,
    );
}

/** Installed assets eligible for an action on this machine. */
function localCandidates(
  items: readonly InventoryItem[],
  kind: AssetKind,
  action: AssetAction | "rename",
) {
  return items.filter(
    (item) =>
      item.kind === kind &&
      !item.via.includes("config") &&
      item.origin !== "—" &&
      (action === "enable"
        ? item.state === "disabled"
        : action === "disable"
          ? item.state !== "disabled"
          : true),
  );
}

const localChoice = (item: InventoryItem): PickChoice<InventoryItem> => ({
  value: item,
  name: item.installedName,
  hint: `${item.origin} · ${item.state}`,
});

type ListCommandOptions = ListFilter & {
  paths?: boolean;
  page: number;
  limit: number;
};

export function registerEnvironment(program: Command, context: CommandContext) {
  for (const kind of ["skill", "mcp", "hook"] as const) {
    const labels = kindLabels[kind];
    const group = labels.group;
    const addCommand = `barndog ${group} add${
      kind === "mcp" ? "" : kind === "skill" ? " <source>" : " <url>"
    }`;
    const command = program
      .command(group)
      .description(
        kind === "skill"
          ? "Install, browse and manage Skills"
          : kind === "mcp"
            ? "Install, browse and manage MCP servers"
            : "Install, browse and manage Hooks",
      );

    const listCommand = command
      .command("list")
      .description(`List installed, disabled and available ${labels.many}`);
    pageOptions(listCommand)
      .option("--installed", `Only ${labels.many} installed on this machine`)
      .option("--disabled", `Only ${labels.many} you've disabled`)
      .option("--available", `Only ${labels.many} you can install`)
      .option("--paths", "Show installed folders and configuration files")
      .action(async (options: ListCommandOptions) => {
        const narrowed = options.installed || options.disabled;
        const onlyAvailable = options.available && !narrowed;
        let catalogProblem: string | undefined;
        const [inventory, rows] = await Promise.all([
          context.inventory(),
          options.available || !narrowed
            ? context.searchCatalog(kind).catch((error: unknown) => {
                if (onlyAvailable) throw error;
                catalogProblem = friendlyMessage(error);
                return [];
              })
            : [],
        ]);
        const items = inventory.items.filter((item) => item.kind === kind);
        const listing = assetListing(items, rows, options);
        if (context.mode.json) return context.write(json(listing));
        if (inventory.offline)
          context.write(dim(`Showing local state only: ${inventory.offline}`));
        else if (catalogProblem)
          context.write(
            dim(`Couldn't load available ${labels.many}: ${catalogProblem}`),
          );
        if (!listing.length) {
          if (narrowed) {
            context.write(`No ${labels.many} match that filter.`);
            return;
          }
          if (catalogProblem || inventory.offline) {
            context.write(`No ${labels.many} on this machine yet.`);
            return;
          }
          context.write(`No ${labels.many} yet.`);
          context.write(hint(addCommand, "Next"));
          return;
        }
        const start = (options.page - 1) * options.limit;
        const page = listing.slice(start, start + options.limit);
        if (!page.length) {
          context.write(
            `Page ${options.page} is empty. Choose a page from 1 to ${Math.ceil(listing.length / options.limit)}.`,
          );
          return;
        }
        for (const line of renderInventory(page, options)) context.write(line);
        if (listing.length > options.limit) {
          const flags = (["installed", "disabled", "available"] as const)
            .filter((flag) => options[flag])
            .map((flag) => ` --${flag}`)
            .join("");
          context.write(
            "\n" +
              dim(
                `Showing ${start + 1}–${start + page.length} of ${listing.length}`,
              ),
          );
          if (start + page.length < listing.length)
            context.write(
              hint(
                `barndog ${group} list${flags} --page ${options.page + 1}`,
                "Next",
              ),
            );
        }
        const onThisMachine = page.filter(
          (item): item is InventoryItem => item.state !== "available",
        );
        const hints = inventoryHints(onThisMachine);
        if (hints.length) context.write(["", ...hints].join("\n"));
        else if (!options.paths && onThisMachine.length)
          context.write(
            "\n" +
              hint(`barndog ${group} list --paths`, "Tip") +
              dim("  to see where each one lives"),
          );
      });

    const search = async (
      assetKind: AssetKind,
      query: string | undefined,
      options: Omit<ListOptions, "search">,
    ) => {
      const [rows, inventory] = await Promise.all([
        context.searchCatalog(assetKind),
        context.inventory().catch(() => undefined),
      ]);
      const selected = new Set(
        inventory?.items
          .filter((item) => item.state !== "removing")
          .map((item) => item.id) ?? [],
      );
      // JSON gets the same matches the table shows, all pages at once.
      if (context.mode.json)
        return context.write(
          json(
            filterAssets(rows, { ...options, search: query }).map((row) => ({
              ...row,
              selected: selected.has(row.id),
            })),
          ),
        );
      for (const line of renderCatalog(
        rows,
        { ...options, search: query },
        `barndog ${group} search`,
        selected,
      ))
        context.write(line);
    };

    assetListOptions(
      command
        .command("search [query]")
        .description(`Browse ${labels.many} published in your workspace`),
      false,
    ).action((query: string | undefined, options: ListOptions) =>
      search(kind, query ?? options.search, options),
    );

    command
      .command("install [name]")
      .description(
        `Install ${labels.many} on this machine; choose from a list when no name is given`,
      )
      .option("--origin <origin>", ORIGIN_HELP)
      .addOption(
        new Option(
          "--overrides <choice>",
          "Keep or clear your existing exclusions",
        ).choices(["preserve", "clear"]),
      )
      .option("--decisions <file>", "JSON per-asset override choices")
      .action(
        async (
          name: string | undefined,
          options: {
            origin?: string;
            overrides?: "preserve" | "clear";
            decisions?: string;
          },
        ) => {
          if (name)
            return runSelection(context, "install", { ...options, name, kind });
          requireArguments(
            context,
            `barndog ${group} install <name> --origin <origin>`,
          );
          const [rows, inventory] = await Promise.all([
            context.searchCatalog(kind),
            context.inventory(),
          ]);
          const selected = new Set(
            inventory.items
              .filter((item) => item.state !== "removing")
              .map((item) => item.id),
          );
          const inOrigin = rows.filter(
            (row) =>
              !options.origin ||
              originLabel(row.origin) === options.origin.replace(":", "/"),
          );
          const ids = await pickMany(
            `Choose ${labels.many} to install`,
            inOrigin
              .filter((row) => !selected.has(row.id))
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((row) => ({
                value: row.id,
                name: row.name,
                hint: `${originLabel(row.origin)} · ${clean(row.version.description)}`,
              })),
            {
              empty: inOrigin.length
                ? `Every available ${labels.one} is already on this machine.`
                : `No ${labels.many} available to install. Add one with ${addCommand}.`,
            },
          );
          await runSelection(context, "install", {
            kind,
            ids,
            overrides: options.overrides,
            decisions: options.decisions,
          });
        },
      );

    for (const action of ["remove", "enable", "disable"] as const)
      command
        .command(`${action} [name]`)
        .description(
          action === "remove"
            ? `Remove ${labels.many} from this machine, even when a set includes them`
            : action === "enable"
              ? `Turn disabled ${labels.many} back on`
              : `Turn ${labels.many} off without removing them from your selection`,
        )
        .option("--origin <origin>", ORIGIN_HELP)
        .action(
          async (name: string | undefined, options: { origin?: string }) => {
            if (name)
              return runSelection(context, action, { ...options, name, kind });
            requireArguments(context, `barndog ${group} ${action} <name>`);
            const items = localCandidates(
              (await context.inventory()).items,
              kind,
              action,
            );
            const chosen = await pickMany(
              `Choose ${labels.many} to ${action}`,
              items.map(localChoice),
              {
                empty:
                  action === "enable"
                    ? `No ${labels.many} are disabled.`
                    : `No ${labels.many} to ${action} on this machine.`,
              },
            );
            await runSelection(context, action, {
              kind,
              ids: chosen.map((item) => item.id),
            });
          },
        );

    command
      .command("rename [name]")
      .description(`Install ${labels.a} under a different local name`)
      .option("--origin <origin>", ORIGIN_HELP)
      .option(
        "--as <name>",
        "New local name: lowercase letters, numbers and hyphens",
      )
      .option("--reset", "Go back to the published name")
      .action(
        async (
          name: string | undefined,
          options: { origin?: string; as?: string; reset?: boolean },
        ) => {
          let target = name;
          let suggestion: string | undefined;
          if (!target) {
            requireArguments(
              context,
              `barndog ${group} rename <name> --as <new-name>`,
            );
            const item = await pickOne(
              `Choose ${labels.a} to rename`,
              localCandidates(
                (await context.inventory()).items,
                kind,
                "rename",
              ).map(localChoice),
              { empty: `No ${labels.many} to rename on this machine.` },
            );
            target = item.id;
            const [type, slug] = item.origin.split("/");
            suggestion = prefixedName({
              name: item.name,
              origin: { type: type!, slug: slug ?? "" },
            });
          }
          const as = options.reset
            ? undefined
            : await ask(
                context,
                options.as,
                "New local name",
                "--as",
                suggestion,
              );
          await runSelection(context, "rename", {
            kind,
            name: target,
            origin: options.origin,
            as,
            reset: options.reset,
          });
          // A clash prompt during the sync may have chosen a different name.
          const item = (await context.inventory()).items.find(
            (entry) =>
              entry.kind === kind &&
              [entry.id, entry.name, entry.installedName].includes(target!) &&
              (!options.origin || entry.origin === options.origin),
          );
          if (item && !context.mode.json)
            context.write(
              item.installedName === item.name
                ? `${ok("✔")} ${bold(item.name)} uses its published name.`
                : `${ok("✔")} ${bold(item.name)} from ${item.origin} is installed as ${bold(item.installedName)}.`,
            );
        },
      );

    for (const action of ["fork", "promote"] as const)
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
                  hint: `${originLabel(row.origin)} · ${clean(row.version.description)}`,
                })),
              );
              name = row.name;
              origin = originLabel(row.origin);
            }
            origin = await ask(context, origin, "Current scope", "--origin");
            const target = await ask(
              context,
              options.target,
              "Destination scope (me, team/<slug>, repo/<slug> or org)",
              "--target",
              action === "fork" ? "me" : undefined,
            );
            const newName = await ask(
              context,
              options.name,
              "New name",
              "--name",
              name,
            );
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
                : await context.promote(input);
            if (outcome.outcome === "moved") {
              if (context.mode.json) return context.write(json(outcome.move));
              for (const line of renderMove(outcome.move)) context.write(line);
              return;
            }
            const result = outcome.promotion;
            if (context.mode.json) return context.write(json(result));
            context.write(
              result.changeId
                ? `${ok("✔")} Proposed ${bold(newName)} for ${target}. A reviewer must merge the Suggested Change.`
                : `${ok("✔")} Created ${bold(newName)} in ${target}.`,
            );
            context.write(
              result.changeId
                ? hint(`barndog changes show ${result.changeId}`)
                : hint(
                    `barndog ${group} install ${newName} --origin ${target === "me" ? "me" : target}`,
                  ),
            );
          },
        );
  }
  registerSets(program, context);
}

type SetsList = {
  available: { type: string; id: string; slug: string; name?: string }[];
  subscriptions: {
    scope: { type: string; id: string };
    mode: string;
    enabled: boolean;
  }[];
};

function registerSets(program: Command, context: CommandContext) {
  const sets = program
    .command("sets")
    .description(
      "Subscribe to everything a team, repository or the organization shares",
    );
  const load = async () =>
    (await context.environment("sets-list", {})) as SetsList;
  const label = (scope: { type: string; slug?: string; id: string }) =>
    originLabel(scope);

  assetListOptions(
    sets
      .command("list")
      .description(
        "Show your subscriptions and the scopes you can subscribe to",
      ),
  ).action(async (options: ListOptions) => {
    const result = await load();
    if (context.mode.json) return context.write(json(result));
    const subscribed = result.subscriptions.map((subscription) => ({
      subscription,
      scope: result.available.find(
        (s) =>
          s.id === subscription.scope.id && s.type === subscription.scope.type,
      ),
    }));
    context.write(`${section("Subscribed")} ${dim(`(${subscribed.length})`)}`);
    context.write(
      subscribed.length
        ? table(
            subscribed.map(({ subscription, scope }) => [
              bold(
                scope
                  ? label(scope)
                  : `${subscription.scope.type}/${subscription.scope.id}`,
              ),
              scope?.name ?? dim("unavailable"),
              subscription.mode,
              subscription.enabled ? ok("enabled") : dim("disabled"),
            ]),
            { header: ["Scope", "Name", "Mode", "State"] },
          ).join("\n")
        : dim("  None yet."),
    );
    const terms =
      options.search?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    const available = result.available
      .filter(
        (scope) =>
          !result.subscriptions.some(
            (s) => s.scope.id === scope.id && s.scope.type === scope.type,
          ),
      )
      .filter(
        (scope) =>
          (!options.origin ||
            scope.type === options.origin ||
            label(scope) === options.origin.replace(":", "/")) &&
          terms.every((term) =>
            `${label(scope)} ${scope.name ?? ""}`.toLowerCase().includes(term),
          ),
      )
      .sort((a, b) => label(a).localeCompare(label(b)));
    const start = (options.page - 1) * options.limit;
    const page = available.slice(start, start + options.limit);
    context.write("");
    context.write(`${section("Available")} ${dim(`(${available.length})`)}`);
    context.write(
      page.length
        ? table(
            page.map((scope) => [bold(label(scope)), scope.name ?? ""]),
            { header: ["Scope", "Name"] },
          ).join("\n")
        : dim("  Nothing else to subscribe to."),
    );
    if (start + options.limit < available.length)
      context.write(hint(`barndog sets list --page ${options.page + 1}`));
    context.write("");
    context.write(hint("barndog sets install", "Tip") + dim("  to subscribe"));
  });

  const chooseScope = async (
    message: string,
    filter: (
      scope: SetsList["available"][number],
      subscribed: boolean,
    ) => boolean,
    empty: string,
  ) => {
    const result = await load();
    return pickOne(
      message,
      result.available
        .filter((scope) =>
          filter(
            scope,
            result.subscriptions.some(
              (s) => s.scope.id === scope.id && s.scope.type === scope.type,
            ),
          ),
        )
        .sort((a, b) => label(a).localeCompare(label(b)))
        .map((scope) => ({
          value: label(scope),
          name: label(scope),
          hint: scope.name,
        })),
      { empty },
    );
  };

  for (const action of ["install", "remove", "enable", "disable"] as const) {
    const command = sets
      .command(`${action} [scope]`)
      .description(
        action === "install"
          ? "Subscribe to a scope's shared assets"
          : action === "remove"
            ? "Unsubscribe from a scope"
            : action === "enable"
              ? "Turn a paused subscription back on"
              : "Pause a subscription without removing it",
      )
      .option(
        "--origin <origin>",
        "Scope, such as org, team/engineering or repo/web-app",
      );
    if (action === "install")
      command
        .addOption(
          new Option(
            "--mode <mode>",
            "Which assets to include; asks when omitted",
          ).choices(["recommended", "optional", "all"]),
        )
        .addOption(
          new Option(
            "--overrides <choice>",
            "Keep or clear your existing exclusions",
          ).choices(["preserve", "clear"]),
        )
        .option("--decisions <file>", "JSON per-asset override choices");
    command.action(async (scope: string | undefined, options) => {
      let origin = scope ?? options.origin;
      if (!origin) {
        requireArguments(context, `barndog sets ${action} <scope>`);
        origin = await chooseScope(
          action === "install"
            ? "Choose a scope to subscribe to"
            : `Choose a subscription to ${action}`,
          (_, subscribed) => (action === "install" ? !subscribed : subscribed),
          action === "install"
            ? "You're already subscribed to every scope."
            : "You have no subscriptions yet.",
        );
      }
      return action === "install"
        ? runSetInstall(context, { ...options, origin })
        : runSelection(context, `sets-${action}`, { ...options, origin });
    });
  }

  const switchCommand = (name: string, hidden: boolean) =>
    sets
      .command(`${name} [scope]`, { hidden })
      .description(
        "Switch to another team or repository, replacing your current one of that type",
      )
      .addOption(
        new Option("--mode <mode>", "Which assets to include")
          .choices(["recommended", "optional", "all"])
          .default("recommended"),
      )
      .addOption(
        new Option(
          "--overrides <choice>",
          "Keep or clear your existing exclusions",
        ).choices(["preserve", "clear"]),
      )
      .option("--decisions <file>", "JSON per-asset override choices")
      .action(async (scope: string | undefined, options) => {
        let origin =
          scope && name === "switch-team" && !scope.includes("/")
            ? `team/${scope}`
            : scope;
        if (!origin) {
          requireArguments(
            context,
            "barndog sets switch <team/slug|repo/slug>",
          );
          origin = await chooseScope(
            "Switch to",
            (candidate, subscribed) =>
              !subscribed &&
              (candidate.type === "team" || candidate.type === "repo"),
            "There is no other team or repository to switch to.",
          );
        }
        await runSelection(context, "switch", { ...options, origin });
      });
  switchCommand("switch", false);
  switchCommand("switch-team", true);
}
