import { InvalidArgumentError } from "commander";
import { POSITIVE_INTEGER } from "../shared/patterns.js";

/** Commander option parser for counts, pages, line numbers and revisions. */
export function positiveInteger(value: string): number {
  if (!POSITIVE_INTEGER.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new InvalidArgumentError("Use a positive integer");
  }

  return Number(value);
}
