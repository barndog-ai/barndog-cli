import type { PackageDetails } from "../features/inventory/show.js";
import { adapters, hookHarnesses } from "../harnesses/registry.js";
import { SHORT_COMMIT_LENGTH } from "../shared/constants.js";
import { bold, clean, dim, fields } from "./format.js";
import { stateBadge } from "./assets.js";
import { renderHookTools } from "./hook-compatibility.js";

/** `skills show` and `hooks show`: what the asset is and where this machine has it. */
export function renderPackageDetails(details: PackageDetails): string[] {
  const { installed } = details;
  const events = hookHarnesses.flatMap((harness) => {
    const names = details.events?.[harness];

    return names ? [`${adapters[harness].name}: ${names.join(", ")}`] : [];
  });

  const output = fields([
    ["Name", bold(clean(details.name))],
    ["Origin", details.origin],
    [
      "Version",
      typeof details.version === "number"
        ? `v${details.version}`
        : details.version.slice(0, SHORT_COMMIT_LENGTH),
    ],
    ["Description", clean(details.description)],
    ["State", installed ? stateBadge(installed.state) : dim("not installed")],
    [
      "Installed in",
      installed?.harnesses.map((harness) => adapters[harness].name).join(", "),
    ],
  ]);

  if (details.compatibility) {
    output.push("", ...renderHookTools(details.name, details.compatibility));
  } else if (details.kind === "hook") {
    output.push(
      "",
      dim("Events"),
      ...(events.length ? events : [dim("No coding tool runs it.")]).map(
        (line) => `  ${line}`,
      ),
    );
  }

  if (installed?.paths.length) {
    output.push(
      "",
      dim("Paths"),
      ...installed.paths.map((path) => `  ${path}`),
    );
  }

  return output;
}
