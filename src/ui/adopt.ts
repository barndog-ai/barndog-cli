import checkbox, { Separator } from "@inquirer/checkbox";
import confirm from "@inquirer/confirm";

import {
  adoptNative,
  adoptionPlan,
  type AdoptionResult,
  type PlannedAsset,
} from "../features/adoption/adopt.js";
import type { AdoptionSummary } from "../features/adoption/record.js";
import type { UndoResult } from "../features/adoption/undo.js";
import {
  scanNative,
  type NativeAsset,
  type NativeScan,
} from "../features/adoption/scan.js";
import { friendlyMessage, promptCancelled } from "../errors.js";
import { harnesses, adapters, type Harness } from "../harnesses/registry.js";
import type { RuntimeContext } from "../runtime.js";
import {
  bold,
  checklistPageSize,
  choiceDescription,
  dim,
  heading,
  hint,
  ok,
  plural,
  table,
  warn,
} from "./format.js";
import { displayPath } from "./output.js";
import { variableProblemLines } from "./variable-problems.js";
import type { KeptChoice } from "../features/mcps/import.js";
import {
  LOCAL_URL_QUERY,
  renderMcpValues,
  renderSignIn,
  renderUrlQueries,
} from "./mcp.js";
import { checkboxTheme, promptTheme } from "./theme.js";

/** Asks which scanned assets to adopt and returns their keys; tests pass their own answer. */
export type ChooseAdoption = (scan: NativeScan) => Promise<string[]>;

/** Asks whether to go ahead with an adoption plan. */
export type ConfirmAdoption = (plan: PlannedAsset[]) => Promise<boolean>;

const kindLabels: Record<NativeAsset["kind"], string> = {
  skill: "Skill",
  mcp: "MCP",
  hook: "Hook",
};

const kindWidth = Math.max(
  ...Object.values(kindLabels).map((label) => label.length),
);

/** How the asset relates to other tools' assets of the same name, when it does. */
function sharing(asset: NativeAsset) {
  if (!asset.sameName.length) {
    return "";
  }

  const tools = asset.sameName
    .map((other) => adapters[other.harness].name)
    .join(", ");

  return asset.identical ? `same as ${tools}` : `differs from ${tools}`;
}

const byTool = <T extends { harness: Harness }>(items: readonly T[]) =>
  harnesses.flatMap((harness) => {
    const mine = items.filter((item) => item.harness === harness);

    return mine.length ? [{ harness, items: mine }] : [];
  });

/** What a scan found, one section per coding tool. */
export function renderScan(
  scan: NativeScan,
  runtime: RuntimeContext,
): string[] {
  const output: string[] = [];
  if (!scan.assets.length) {
    output.push(
      `${ok("✔")} Nothing left to adopt: BarnDog manages every Skill, MCP server and Hook it can take over from your coding tools.`,
    );

    if (!scan.skipped.length) {
      return output;
    }

    output.push("");
  }

  for (const { harness, items } of byTool(scan.assets)) {
    output.push(bold(adapters[harness].name));
    output.push(
      ...table(
        items.map((asset) => [
          dim(kindLabels[asset.kind]),
          bold(asset.name),
          asset.identical ? dim(sharing(asset)) : warn(sharing(asset)),
          dim(asset.key),
        ]),
      ),
    );

    output.push("");
  }

  if (scan.skipped.length) {
    output.push(bold("Can't be adopted"));
    for (const skipped of scan.skipped) {
      output.push(
        `  ${dim(`${adapters[skipped.harness].name} ${kindLabels[skipped.kind]}`)} ${bold(skipped.name)} ${dim(displayPath(skipped.location, runtime))}`,
        `    ${dim(skipped.reason)}`,
      );
    }

    output.push("");
  }

  return output;
}

/**
 * Columns Inquirer draws before a choice's name (cursor, then a circle such as
 * ` ◯`, then a space); a text row is indented to match.
 */
const CHOICE_PREFIX_WIDTH = 4;

/** What a same-named copy picked in an earlier tool's checklist does to this one, if one was picked. */
function broughtAlong(asset: NativeAsset, picked: readonly string[]) {
  const twin = asset.sameName.find((other) => picked.includes(other.key));
  if (!twin) {
    return undefined;
  }

  const tool = adapters[twin.harness].name;

  return asset.identical
    ? `already comes with ${tool}`
    : warn(`replaced by ${tool}'s copy`);
}

/**
 * One tool's checklist: the assets still to choose, then, as text the cursor
 * skips, those an earlier pick already brings along. Returns no choices when
 * nothing is left to pick.
 */
function adoptionChoices(
  items: readonly NativeAsset[],
  picked: readonly string[],
) {
  const nameWidth = Math.max(...items.map((asset) => asset.name.length));
  const label = (asset: NativeAsset) =>
    `${kindLabels[asset.kind].padEnd(kindWidth)} ${asset.name.padEnd(nameWidth)}`;

  const open = items.filter((asset) => !broughtAlong(asset, picked));
  const along = items.flatMap((asset) => {
    const note = broughtAlong(asset, picked);

    return note
      ? [
          new Separator(
            `${" ".repeat(CHOICE_PREFIX_WIDTH - 1)}${dim(label(asset))}  ${note}`,
          ),
        ]
      : [];
  });

  if (!open.length) {
    return [];
  }

  return [
    ...open.map((asset) => ({
      value: asset.key,
      checked: false,
      short: asset.key,
      name: `${label(asset)}${sharing(asset) ? dim(`  ${sharing(asset)}`) : ""}`,
      description: choiceDescription(asset.description),
    })),
    ...along,
  ];
}

/** Asks tool by tool, so each checklist names the tool its assets are in. */
const chooseAdoption: ChooseAdoption = async (scan) => {
  const picked: string[] = [];
  for (const { harness, items } of byTool(scan.assets)) {
    const choices = adoptionChoices(items, picked);

    // Inquirer refuses a checklist with nothing left to pick.
    if (!choices.length) {
      continue;
    }

    picked.push(
      ...(await checkbox<string>({
        loop: false,
        message: `Which ${bold(adapters[harness].name)} assets should BarnDog adopt?`,
        choices,
        pageSize: checklistPageSize(items.length),
        theme: checkboxTheme,
      })),
    );
  }

  return picked;
};

/** What an adoption will take over, including other tools' copies BarnDog's one replaces. */
function renderPlan(plan: PlannedAsset[]): string[] {
  const output = [bold("BarnDog will adopt")];
  output.push(
    ...table(
      plan.map((asset) => [
        adapters[asset.harness].name,
        dim(kindLabels[asset.kind]),
        bold(asset.name),
        asset.source.key !== asset.key && !asset.identical
          ? warn(`replaced by ${adapters[asset.source.harness].name}'s`)
          : "",
      ]),
    ),
  );

  output.push(
    "",
    dim(
      "Originals move into ~/.barndog/adoptions/ and BarnDog installs its copies in their place.",
    ),
    dim(
      "Adopted Skills and MCP servers install in every coding tool BarnDog manages.",
    ),
  );

  // Same-named copies share one source, so each server is named once.
  const queries = plan
    .filter((asset) => asset.key === asset.source.key)
    .flatMap(({ name, queryParameters: parameters }) =>
      parameters.length ? [{ name, parameters }] : [],
    );

  if (queries.length) {
    output.push("", ...renderUrlQueries(queries), dim(LOCAL_URL_QUERY));
  }

  return output;
}

const confirmAdoption: ConfirmAdoption = (plan) =>
  confirm({
    message: `Adopt ${plural(plan.length, "asset")}?`,
    default: true,
    theme: promptTheme,
  });

export function renderAdoption(
  result: AdoptionResult,
  runtime: RuntimeContext,
): string[] {
  const output = [
    `${ok("✔")} Adopted ${plural(result.adopted.length, "asset")} into your local folder.`,
    dim(`Originals are saved in ${displayPath(result.backup, runtime)}`),
  ];

  for (const note of result.notes) {
    output.push(
      `${warn("!")} ${kindLabels[note.kind]} ${bold(note.name)}: ${note.text}`,
    );
  }

  output.push(...renderSignIn(result.signIn));
  output.push(...renderMcpValues(result.values));
  output.push(...variableProblemLines(result.events, result.values));

  output.push(
    "",
    result.canShare
      ? hint("barndog local move", "Tip") +
          dim("  share them through your workspace")
      : hint("barndog local list", "Tip") +
          dim("  see everything in your local workspace"),
  );

  return output;
}

export function renderUndo(
  result: UndoResult,
  runtime: RuntimeContext,
): string[] {
  const output = [
    `${ok("✔")} Put back ${plural(result.restored.length, "asset")}.`,
    ...result.restored.map(
      (item) =>
        `  ${adapters[item.harness].name} ${dim(kindLabels[item.kind])} ${bold(item.name)} ${dim(displayPath(item.location, runtime))}`,
    ),
  ];

  if (result.remaining.length) {
    output.push(
      "",
      dim(
        `${plural(result.remaining.length, "asset")} of this adoption ${result.remaining.length === 1 ? "is" : "are"} still managed by BarnDog.`,
      ),
    );
  }

  return output;
}

export function renderAdoptions(list: AdoptionSummary[]): string[] {
  if (!list.length) {
    return [dim("Nothing has been adopted on this machine.")];
  }

  return table(
    list.map((record) => [
      record.id,
      dim(record.createdAt.slice(0, "YYYY-MM-DD".length)),
      record.status === "applied" ? ok(record.status) : warn(record.status),
      record.items
        .map((item) => (item.undone ? dim(item.key) : item.key))
        .join(", "),
    ]),
    { header: ["ID", "Date", "Status", "Assets"] },
  );
}

/** The operations the adoption prompt needs. */
export type AdoptionPrompt = {
  adoptNative: (
    keys: readonly string[],
    keep: readonly KeptChoice[],
  ) => Promise<AdoptionResult>;
  write: (message: string) => void;
  runtime: RuntimeContext;
  choose?: ChooseAdoption;
  confirm?: ConfirmAdoption;
  keepValues?: ChooseKeptValues;
};

/** Which of the plan's MCP values BarnDog keeps on this machine. */
type ChooseKeptValues = (
  values: { server: string; key: string; variable: string }[],
) => Promise<KeptChoice[]>;

const chooseKeptValues: ChooseKeptValues = (values) =>
  checkbox({
    loop: false,
    message: "Which values should BarnDog keep on this machine?",
    pageSize: checklistPageSize(values.length),
    choices: values.map((value) => ({
      name: `${value.variable}  ${dim(`${value.server}: ${value.key}`)}`,
      short: value.variable,
      value: { server: value.server, variable: value.variable },
      checked: true,
    })),
    theme: checkboxTheme,
  });

/** Shows what a scan found, asks which assets to adopt, and adopts them. */
export async function offerAdoption(scan: NativeScan, prompt: AdoptionPrompt) {
  const { write } = prompt;

  write(`\n${heading("adopt")}\n`);
  write("These are set up in your coding tools without BarnDog:");
  write("");
  for (const line of renderScan(scan, prompt.runtime)) {
    write(line);
  }

  const keys = await (prompt.choose ?? chooseAdoption)(scan);
  if (!keys.length) {
    write(
      `${dim("Nothing adopted. Run")} ${bold("barndog adopt")} ${dim("any time.")}`,
    );

    return;
  }

  const plan = adoptionPlan(scan, keys);
  write("");
  for (const line of renderPlan(plan)) {
    write(line);
  }

  write("");
  if (!(await (prompt.confirm ?? confirmAdoption)(plan))) {
    write(dim("Nothing adopted."));

    return;
  }

  // Same-named copies share one source, so each value is asked about once.
  const values = plan
    .filter((asset) => asset.key === asset.source.key)
    .flatMap((asset) =>
      asset.values.map((value) => ({ server: asset.name, ...value })),
    );

  let keep: KeptChoice[] = [];
  if (values.length) {
    write("");
    write(
      dim(
        "These MCP values were written into the tools' settings. BarnDog can keep them in ~/.barndog/secrets.json, which only you can read and which is never uploaded, and write them into each tool it manages. Leave one unticked to set it yourself.",
      ),
    );

    keep = await (prompt.keepValues ?? chooseKeptValues)(values);
  }

  const result = await prompt.adoptNative(keys, keep);
  for (const line of renderAdoption(result, prompt.runtime)) {
    write(line);
  }
}

/**
 * First-time setup offers to adopt what the tools already have. Setup is saved
 * by then, so a failure here is reported rather than failing setup.
 */
export async function offerAdoptionAtSetup(
  runtime: RuntimeContext,
  prompt: Pick<AdoptionPrompt, "write" | "choose" | "confirm" | "keepValues">,
) {
  try {
    const scan = await scanNative(runtime);
    if (scan.assets.length) {
      await offerAdoption(scan, {
        ...prompt,
        adoptNative: (keys, keep) => adoptNative(keys, keep, runtime),
        runtime,
      });
    }
  } catch (error) {
    if (promptCancelled(error)) {
      prompt.write(
        `${dim("Adoption cancelled; nothing was adopted. Run")} ${bold("barndog adopt")} ${dim("any time.")}`,
      );

      return;
    }

    prompt.write(`${warn("!")} Nothing was adopted: ${friendlyMessage(error)}`);
    prompt.write(hint("barndog adopt", "Tip") + dim("  try again later"));
  }
}
