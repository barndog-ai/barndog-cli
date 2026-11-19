import type { RuntimeContext } from "../../runtime.js";
import {
  copyToScope,
  type PromoteInput,
  type Promotion,
} from "../discovery/index.js";
import { LOCAL_ORIGIN } from "../workspace/overlay.js";
import { moveLocalAssets, type MoveResult } from "./move.js";

/**
 * Distinguishes a server promotion from a local asset move so callers can
 * render either outcome.
 */
export type PromoteResult =
  | { outcome: "promoted"; promotion: Promotion }
  | { outcome: "moved"; move: MoveResult };

/**
 * Proposes an asset for another scope. A local asset has no server copy to
 * propose from, so it is moved there instead and the result is that move.
 */
export async function promote(
  input: PromoteInput,
  runtime: RuntimeContext,
): Promise<PromoteResult> {
  if (input.origin === LOCAL_ORIGIN) {
    return {
      outcome: "moved",
      move: await moveLocalAssets(
        {
          names: [input.name],
          kind: input.kind,
          // Promoting shares a copy; the original stays, as on the server.
          keepLocal: true,
          to: input.target,
          as: input.newName === input.name ? undefined : input.newName,
        },
        runtime,
      ),
    };
  }

  return {
    outcome: "promoted",
    promotion: await copyToScope("promote", input, runtime),
  };
}
