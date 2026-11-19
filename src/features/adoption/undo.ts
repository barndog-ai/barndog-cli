/** `barndog adopt undo`: put adopted assets back in their coding tools. */
import { CliError } from "../../errors.js";
import type { RuntimeContext } from "../../runtime.js";
import { locked } from "../environment/transaction.js";
import { copyFingerprint } from "./copies.js";
import { findAdoption, summary, type AdoptedAsset } from "./record.js";
import { restore } from "./restore.js";

/** Which adoption to undo, and how much of it. */
export type UndoTarget = {
  /** The newest adoption with something left to undo when absent. */
  id?: string;
  /** Keys to undo; every asset sharing a name with one goes back with it. */
  only?: readonly string[];
  /** Undo even when BarnDog's copy was edited since, losing those edits. */
  force?: boolean;
};

/** What `barndog adopt undo` put back. */
export type UndoResult = {
  id: string;
  restored: AdoptedAsset[];
  /** Assets of this adoption BarnDog still manages. */
  remaining: AdoptedAsset[];
};

export async function undoAdoption(
  target: UndoTarget,
  runtime: RuntimeContext,
): Promise<UndoResult> {
  const { home } = runtime;

  return locked(runtime, async () => {
    const record = await findAdoption(target.id, home);
    const open = record.items.filter((item) => !item.undone);
    const unknown = (target.only ?? []).filter(
      (key) => !open.some((item) => item.key === key),
    );

    if (unknown.length) {
      throw new CliError(
        `Adoption ${record.id} has nothing to undo for ${unknown.join(", ")}.`,
        "barndog adopt list",
      );
    }

    if (target.only && record.status === "pending") {
      throw new CliError(
        `Adoption ${record.id} didn't finish, so it can only be undone as a whole.`,
        `barndog adopt undo ${record.id}`,
      );
    }

    const chosen = target.only
      ? open.filter((item) =>
          open.some(
            (picked) =>
              target.only?.includes(picked.key) && picked.copy === item.copy,
          ),
        )
      : open;

    if (!chosen.length) {
      throw new CliError(
        `Adoption ${record.id} was already undone.`,
        "barndog adopt list",
      );
    }

    // A pending adoption may have stopped before its copies were fingerprinted.
    if (!target.force && record.status !== "pending") {
      for (const item of chosen) {
        const now = await copyFingerprint(item, runtime);
        if (now !== null && now !== item.fingerprint) {
          throw new CliError(
            `${item.copy} changed since ${item.name} was adopted, and undoing would lose those changes.`,
            "Save your changes somewhere else, then undo with --force",
            { command: `barndog adopt undo ${record.id} --force` },
          );
        }
      }
    }

    await restore(record, chosen, runtime);

    const { items } = summary(record);

    return {
      id: record.id,
      restored: items.filter((item) => chosen.some((c) => c.key === item.key)),
      remaining: items.filter((item) => !item.undone),
    };
  });
}
