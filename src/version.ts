import { readFileSync } from "node:fs";

import { defaultServer } from "./config/build.js";

/** The package version, read from package.json beside dist/ so it can't drift. */
export const version = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

/** What `barndog --version` prints: enough to tell builds apart in a support report. */
export function versionReport() {
  return [
    `barndog ${version}`,
    `Node.js ${process.version} on ${process.platform} ${process.arch}`,
    `Default server ${defaultServer}`,
  ].join("\n");
}
