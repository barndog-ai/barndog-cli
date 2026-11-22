/** The notice printed after a command when a newer BarnDog CLI is published. */
import type { AvailableUpdate } from "../features/update-check/index.js";
import { bold, dim } from "./format.js";

export function renderUpdateNotice(update: AvailableUpdate): string[] {
  const install = `npm install -g barndog@${update.tag}`;

  return [
    "",
    `A new BarnDog CLI is available: ${update.current} → ${bold(update.version)}`,
    // Sync brings the registrations in each tool in line with the new version.
    `${dim("Next:")} ${bold(install)}, then ${bold("barndog sync")}`,
  ];
}
