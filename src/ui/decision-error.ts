import { CliError } from "../errors.js";
import { assetKinds } from "../features/asset-kinds/index.js";
import type {
  AssetReference,
  OverrideConflict,
} from "../features/asset-selection/types.js";

/** One asset whose exclusion or disable needs `preserve` or `clear`. */
export type PendingDecision = {
  assetId: string;
  kind: AssetReference["kind"];
  name: string;
};

/**
 * A change that would undo exclusions or disables, run where nobody can be
 * asked. It names every asset, so a `--decisions` file can be written for it;
 * `--json` lists them under `decisions`.
 */
export class DecisionRequiredError extends CliError {
  readonly decisions: PendingDecision[];

  constructor(conflicts: readonly OverrideConflict[]) {
    const decisions = conflicts.map(({ asset }) => ({
      assetId: asset.id,
      kind: asset.kind,
      name: asset.name,
    }));

    super(
      [
        "Existing exclusions or disabled assets need a decision:",
        ...conflicts.map(
          ({ asset }) =>
            `  ${asset.name} (${assetKinds[asset.kind].one})  ${asset.id}`,
        ),
        'A --decisions file lists each one as {"assetId": "<id>", "choice": "preserve"} or "clear".',
      ].join("\n"),
      "add --overrides preserve, --overrides clear or --decisions <file>",
    );

    this.name = "DecisionRequiredError";
    this.decisions = decisions;
  }
}
