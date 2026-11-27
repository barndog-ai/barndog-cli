import { SHORT_COMMIT_LENGTH } from "../shared/constants.js";
import { adapters, hookHarnesses } from "../harnesses/registry.js";
import type { HookHarness } from "../harnesses/types.js";
import type {
  HarnessCompatibility,
  HookCompatibility,
} from "../features/hooks/types.js";
import type { HookCompatibilityRow } from "../features/inventory/hook-matrix.js";
import {
  requirementFix,
  type MissingRequirement,
} from "../features/native/requirements.js";
import { bold, dim, fields, hint, ok, table, warn } from "./format.js";

/** What the author declares for a tool: `—` when the Hook isn't written for it. */
function authorSays(row: HarnessCompatibility) {
  switch (row.status) {
    case "supported":
      return ok("supported");
    case "partial":
      return warn("partial");
    case "unsupported":
      return dim("—");
  }
}

function onThisMachine(row: HarnessCompatibility) {
  if (row.status === "unsupported") {
    return dim("—");
  }

  return row.missingRequirements.length
    ? warn("! missing requirement")
    : ok("✔ ready");
}

/** One cell of `hooks compatibility --all`. */
function matrixCell(row: HarnessCompatibility | undefined) {
  if (!row || row.status === "unsupported") {
    return dim("—");
  }

  if (row.missingRequirements.length) {
    return warn("! can't run");
  }

  return row.status === "partial" ? warn("◐ partial") : ok("✔ supported");
}

/** How a missing requirement reads beside the requirement it belongs to. */
function shortStatus(harness: HookHarness, missing: MissingRequirement) {
  const tool = adapters[harness].name;

  switch (missing.type) {
    case "command":
      return "not installed or not on your PATH";
    case "invalid-range":
      return "not a valid version range";
    case "tool-missing":
      return `can't find ${tool}`;
    case "version-unknown":
      return `couldn't read ${tool}'s version`;
    case "version":
      return `this machine has ${missing.installed}`;
  }
}

/** Each declared requirement with whether this machine meets it, and the fixes for those it doesn't. */
function requirementLines(rows: readonly HarnessCompatibility[]): string[] {
  const lines: string[][] = [];
  const fixes = new Set<string>();
  for (const row of rows) {
    const requirements = row.implementation?.requirements;
    if (!requirements) {
      continue;
    }

    const tool = adapters[row.harness].name;
    const status = (missing: MissingRequirement | undefined) => {
      if (!missing) {
        return ok("✔");
      }

      fixes.add(requirementFix(row.harness, missing));

      return warn(`! ${shortStatus(row.harness, missing)}`);
    };

    for (const command of requirements.commands) {
      lines.push([
        tool,
        `${bold(command)} command`,
        status(
          row.missingRequirements.find(
            (missing) =>
              missing.type === "command" && missing.command === command,
          ),
        ),
      ]);
    }

    if (requirements.harnessVersion) {
      lines.push([
        tool,
        `${tool} ${requirements.harnessVersion}`,
        status(
          row.missingRequirements.find((missing) => missing.type !== "command"),
        ),
      ]);
    }
  }

  if (!lines.length) {
    return [];
  }

  return [
    "",
    dim("Requirements"),
    ...table(lines),
    ...[...fixes].map(
      (fix) => `  ${dim("Fix:")} ${fix}, then run ${bold("barndog sync")}`,
    ),
  ];
}

/** What the author wrote about partial support, or that they wrote nothing. */
function noteLines(rows: readonly HarnessCompatibility[]): string[] {
  const notes = rows.flatMap((row) => {
    const text = row.implementation?.notes?.trim();
    if (text) {
      return [[adapters[row.harness].name, text]];
    }

    return row.status === "partial"
      ? [
          [
            adapters[row.harness].name,
            dim(
              "The author marked this partial but didn't say what's missing.",
            ),
          ],
        ]
      : [];
  });

  if (!notes.length) {
    return [];
  }

  return [
    "",
    dim("Author's notes"),
    ...table(notes.map(([tool = "", text = ""]) => [bold(tool), text])),
  ];
}

/**
 * A Hook in each tool BarnDog manages: what the author declares, whether this
 * machine can run it, its events, requirements and the author's notes.
 */
export function renderHookTools(
  name: string,
  rows: readonly HarnessCompatibility[],
): string[] {
  const missing = rows.filter((row) => row.status === "unsupported");
  const partial = rows.some((row) => row.status === "partial");

  return [
    dim("Tools"),
    ...table(
      rows.map((row) => [
        adapters[row.harness].name,
        authorSays(row),
        onThisMachine(row),
        row.implementation
          ? Object.keys(row.implementation.events).join(", ")
          : dim("—"),
      ]),
      { header: ["Tool", "Author says", "On this machine", "Events"] },
    ),
    ...requirementLines(rows),
    ...noteLines(rows),
    ...(partial
      ? [
          "",
          dim(
            "partial: the author says only part of this Hook works in that tool.",
          ),
        ]
      : []),
    ...(missing.length
      ? [
          "",
          `${dim(`No ${missing.map((row) => adapters[row.harness].name).join(" or ")} version yet.`)} ${hint(`barndog hooks adapt ${name} --for ${missing.map((row) => row.harness).join(" ")}`, "Tip")}`,
        ]
      : []),
  ];
}

/**
 * Returns a Hook's version, then its support and readiness per tool,
 * abbreviating content hashes to seven characters.
 */
export function renderHookCompatibility(
  name: string,
  result: HookCompatibility,
): string[] {
  return [
    // A content hash is long; its first 7 characters identify it, as Git shows them.
    ...fields([
      [
        "Version",
        typeof result.version === "number"
          ? String(result.version)
          : result.version.slice(0, SHORT_COMMIT_LENGTH),
      ],
    ]),
    "",
    ...renderHookTools(name, result.compatibility),
  ];
}

/** Every selected Hook against every tool BarnDog manages, with what each mark means. */
export function renderHookMatrix(rows: readonly HookCompatibilityRow[]) {
  if (!rows.length) {
    return [dim("No Hooks are selected on this machine.")];
  }

  const tools = hookHarnesses.filter((harness) =>
    rows.some((row) => row.compatibility.some((c) => c.harness === harness)),
  );

  return [
    ...table(
      rows.map((row) => [
        bold(row.name),
        ...tools.map((harness) =>
          matrixCell(row.compatibility.find((c) => c.harness === harness)),
        ),
      ]),
      { header: ["Hook", ...tools.map((harness) => adapters[harness].name)] },
    ),
    "",
    ...table([
      [
        dim("—"),
        dim("not written for that tool, so BarnDog doesn't install it there"),
      ],
      [
        dim("partial"),
        dim("the author says only part of it works in that tool"),
      ],
      [dim("can't run"), dim("this machine is missing something it needs")],
    ]),
    "",
    `  ${hint("barndog hooks show <name>", "Tip")}${dim("  for requirements and the author's notes")}`,
  ];
}
