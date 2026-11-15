import { Option, type Command } from "commander";
import { type CommandContext } from "./context.js";
import { assetListOptions, type ListOptions } from "../ui/asset-list.js";
import { runSetInstall } from "../ui/scope-install.js";
import { type SetsList } from "../features/environment/operations.js";
import { runSelection } from "../ui/selection.js";
import { pickOne } from "../ui/pick.js";
import {
  bold,
  dim,
  hint,
  json,
  ok,
  originLabel,
  section,
  table,
} from "../ui/format.js";
import { requireArguments } from "./arguments.js";

const setDescriptions = {
  install: "Subscribe to a scope's shared assets",
  remove: "Unsubscribe from a scope",
  enable: "Turn a paused subscription back on",
  disable: "Pause a subscription without removing it",
};

/** Options of the `sets` subcommands, as Commander parses them. */
type SetOptions = {
  origin?: string;
  mode?: "recommended" | "optional" | "all";
  overrides?: "preserve" | "clear";
  decisions?: string;
};

export function registerSets(program: Command, context: CommandContext) {
  const sets = program
    .command("sets")
    .description(
      "Subscribe to everything a team, repository or the organization shares",
    );

  const load = () => context.listSets();
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
    if (context.mode.json) {
      return context.write(json(result));
    }

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

    if (start + options.limit < available.length) {
      context.write(hint(`barndog sets list --page ${options.page + 1}`));
    }

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
      .description(setDescriptions[action])
      .option(
        "--origin <origin>",
        "Scope, such as org, team/engineering or repo/web-app",
      );

    if (action === "install") {
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
    }

    command.action(async (scope: string | undefined, options: SetOptions) => {
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
        : runSelection(context, (resolution) =>
            context.changeSet(action, { ...options, origin, resolution }),
          );
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
      .action(async (scope: string | undefined, options: SetOptions) => {
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

        await runSelection(context, (resolution) =>
          context.switchSet({ ...options, origin, resolution }),
        );
      });

  switchCommand("switch", false);
  switchCommand("switch-team", true);
}
