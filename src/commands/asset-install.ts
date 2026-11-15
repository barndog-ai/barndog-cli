import { Option, type Command } from "commander";
import { type CommandContext } from "./context.js";
import { type AssetKind } from "../config/selection.js";
import { type InventoryItem } from "../features/inventory/index.js";
import { prefixedName } from "../features/environment/names.js";
import { runSelection } from "../ui/selection.js";
import { pickMany, pickOne, type PickChoice } from "../ui/pick.js";
import { bold, clean, ok, ORIGIN_HELP, originLabel } from "../ui/format.js";
import { assetKinds } from "../features/asset-kinds/index.js";
import { addArguments, requireArguments } from "./arguments.js";
import { ask } from "./asset-share.js";

type AssetAction = "install" | "remove" | "enable" | "disable";

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
      (action !== "enable" || item.state === "disabled") &&
      (action !== "disable" || item.state !== "disabled"),
  );
}

const localChoice = (item: InventoryItem): PickChoice<InventoryItem> => ({
  value: item,
  name: item.installedName,
  hint: `${item.origin} · ${item.state}`,
});

/** `install`: adds assets of one kind to the selection and syncs. */
export function registerInstall(
  command: Command,
  kind: AssetKind,
  context: CommandContext,
) {
  const labels = assetKinds[kind];
  const group = assetKinds[kind].command;
  const addCommand = `barndog ${assetKinds[kind].command} add${addArguments[kind]}`;

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
        if (name) {
          return runSelection(context, (resolution) =>
            context.changeAsset("install", {
              ...options,
              name,
              kind,
              resolution,
            }),
          );
        }

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

        await runSelection(context, (resolution) =>
          context.changeAssets("install", {
            kind,
            ids,
            overrides: options.overrides,
            decisions: options.decisions,
            resolution,
          }),
        );
      },
    );
}

/** `remove`, `enable` and `disable` for assets installed on this machine. */
export function registerToggles(
  command: Command,
  kind: AssetKind,
  context: CommandContext,
) {
  const labels = assetKinds[kind];
  const group = assetKinds[kind].command;

  for (const action of ["remove", "enable", "disable"] as const) {
    command
      .command(`${action} [name]`)
      .description(
        {
          remove: `Remove ${labels.many} from this machine, even when a set includes them`,
          enable: `Turn disabled ${labels.many} back on`,
          disable: `Turn ${labels.many} off without removing them from your selection`,
        }[action],
      )
      .option("--origin <origin>", ORIGIN_HELP)
      .action(
        async (name: string | undefined, options: { origin?: string }) => {
          if (name) {
            return runSelection(context, (resolution) =>
              context.changeAsset(action, {
                ...options,
                name,
                kind,
                resolution,
              }),
            );
          }

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

          await runSelection(context, (resolution) =>
            context.changeAssets(action, {
              kind,
              ids: chosen.map((item) => item.id),
              resolution,
            }),
          );
        },
      );
  }
}

/** `rename`: installs an asset under another local name. */
export function registerRename(
  command: Command,
  kind: AssetKind,
  context: CommandContext,
) {
  const labels = assetKinds[kind];
  const group = assetKinds[kind].command;

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
          const [type = "", slug = ""] = item.origin.split("/");
          suggestion = prefixedName({
            name: item.name,
            origin: { type, slug },
          });
        }

        const as = options.reset
          ? undefined
          : await ask(context, options.as, {
              message: "New local name",
              flag: "--as",
              fallback: suggestion,
            });

        await runSelection(context, () =>
          context.renameAsset({
            kind,
            name: target,
            origin: options.origin,
            as,
            reset: options.reset,
          }),
        );

        // A clash prompt during the sync may have chosen a different name.
        const renamed = target;
        const item = (await context.inventory()).items.find(
          (entry) =>
            entry.kind === kind &&
            [entry.id, entry.name, entry.installedName].includes(renamed) &&
            (!options.origin || entry.origin === options.origin),
        );

        if (item && !context.mode.json) {
          context.write(
            item.installedName === item.name
              ? `${ok("✔")} ${bold(item.name)} uses its published name.`
              : `${ok("✔")} ${bold(item.name)} from ${item.origin} is installed as ${bold(item.installedName)}.`,
          );
        }
      },
    );
}
