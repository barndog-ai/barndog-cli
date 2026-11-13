import { readFileSync } from "node:fs";
import { z } from "zod";

import { defaultServer } from "./config/build.js";

/** The package version, read from package.json beside dist/ so it can't drift. */
export const version = z
  .object({ version: z.string() })
  .parse(
    JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ),
  ).version;

/** What `barndog --version` prints: enough to tell builds apart in a support report. */
export function versionReport() {
  return [
    `barndog ${version}`,
    `Node.js ${process.version} on ${process.platform} ${process.arch}`,
    `Default server ${defaultServer}`,
  ].join("\n");
}
