import { Argument, type Command } from "commander";
import { styleText } from "node:util";
import { CliError } from "../errors.js";
import { harnesses, type Harness } from "../harnesses/registry.js";
import { toolNames } from "../features/hooks/adapt.js";
import type {
  HarnessChange,
  HarnessesApplied,
  HarnessStatus,
} from "../features/environment/harnesses.js";
import { bold, dim, json, ok, table } from "../ui/format.js";
import { chooseHarnesses } from "../ui/harness-picker.js";
import { renderSyncOutput } from "../ui/output.js";
import { type CommandContext } from "./context.js";

function managedLine(managed: readonly Harness[]) {
  return managed.length
    ? `${ok("✔")} BarnDog now manages ${toolNames(managed)}.`
    : `${ok("✔")} BarnDog no longer manages any coding tool. Add one with ${styleText("bold", "barndog harnesses enable <harness>")}.`;
}

const pickMessage: Record<HarnessChange, string> = {
  enable: "Which coding tools should BarnDog start managing?",
  disable: "Which coding tools should BarnDog stop managing?",
};

const nothingTo: Record<HarnessChange, string> = {
  enable: "BarnDog already manages every coding tool it supports.",
  disable: "BarnDog doesn't manage any coding tool.",
};

const nothingToHint: Record<HarnessChange, string> = {
  enable: "barndog harnesses list",
  disable: "barndog harnesses enable <harness>",
};

function harnessTable(rows: readonly HarnessStatus[]) {
  return table(
    rows.map((row) => [
      bold(row.id),
      row.name,
      row.enabled ? ok("managed") : dim("off"),
      row.evidence ? dim(row.evidence) : dim("not found"),
    ]),
    { header: ["Harness", "Tool", "State", "Detected"] },
  );
}

export function registerHarnesses(program: Command, context: CommandContext) {
  const group = program
    .command("harnesses")
    .description(
      "Choose which coding tools BarnDog manages; a tool turned off loses everything BarnDog installed there",
    );

  group
    .command("list", { isDefault: true })
    .description("List supported coding tools and whether BarnDog manages them")
    .action(async () => {
      const rows = await context.listHarnesses();
      if (context.mode.json) {
        return context.write(json(rows));
      }

      for (const line of harnessTable(rows)) {
        context.write(line);
      }
    });

  const report = (result: HarnessesApplied) => {
    if (context.mode.json) {
      return context.write(json(result));
    }

    for (const line of renderSyncOutput(result.events)) {
      context.write(line);
    }

    context.write(managedLine(result.harnesses));
  };

  // With no tools named, a terminal picks from the ones the change applies to.
  const pickTargets = async (change: HarnessChange): Promise<Harness[]> => {
    const usage = `barndog harnesses ${change} <harness>`;
    if (!context.mode.interactive) {
      throw new CliError(`Name the coding tools to ${change}.`, usage);
    }

    const offered = (await context.listHarnesses()).filter(
      (row) => row.enabled === (change === "disable"),
    );

    if (offered.length === 0) {
      throw new CliError(nothingTo[change], nothingToHint[change]);
    }

    return chooseHarnesses(
      offered.map((row) => ({
        value: row.id,
        name: row.name,
        evidence: row.evidence,
        checked: false,
      })),
      { message: pickMessage[change], required: true },
    );
  };

  for (const change of ["enable", "disable"] as const) {
    group
      .command(change)
      .description(
        change === "enable"
          ? "Start installing your selection into these coding tools"
          : "Remove everything BarnDog installed in these coding tools and stop installing there",
      )
      .addArgument(
        new Argument("[harnesses...]", "Coding tools").choices(harnesses),
      )
      .action(async (named: Harness[]) => {
        const targets = named.length ? named : await pickTargets(change);
        report(await context.changeHarnesses(change, targets));
      });
  }

  group
    .command("select")
    .description(
      "Choose from a list exactly which coding tools BarnDog manages",
    )
    .action(async () => {
      if (!context.mode.interactive) {
        throw new CliError(
          "Choosing coding tools from a list needs a terminal.",
          "barndog harnesses enable <harness>",
        );
      }

      const rows = await context.listHarnesses();
      const chosen = await chooseHarnesses(
        rows.map((row) => ({
          value: row.id,
          name: row.name,
          evidence: row.evidence,
          checked: row.enabled,
        })),
      );

      report(await context.selectHarnesses(chosen));
    });
}
