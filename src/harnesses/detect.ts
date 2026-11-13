import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import which from "which";
import { harnesses, adapters, type DetectedHarness } from "./registry.js";
import { errorCode } from "../shared/values.js";

type DetectionOptions = {
  home?: string;
  path?: string;
  platform?: NodeJS.Platform;
  appDirectories?: string[];
};

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES"].includes(errorCode(error) ?? "")) {
      return false;
    }

    throw error;
  }
}

/** Inspect installation evidence; never execute harnesses or infer installation from skill directories. */
export async function detectHarnesses(
  options: DetectionOptions = {},
): Promise<DetectedHarness[]> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const path = options.path ?? process.env.PATH ?? "";

  const appDirectories = options.appDirectories ?? [
    "/Applications",
    join(home, "Applications"),
  ];

  return Promise.all(
    harnesses.map(async (id) => {
      const installation = adapters[id];
      let evidence: string | null = null;
      for (const command of installation.commands) {
        evidence = path ? await which(command, { path, nothrow: true }) : null;
        if (evidence) {
          break;
        }
      }

      if (!evidence && platform === "darwin") {
        for (const directory of appDirectories) {
          const candidate = join(directory, installation.macApp);
          if (await isDirectory(join(candidate, "Contents", "MacOS"))) {
            evidence = candidate;
            break;
          }
        }
      }

      return { id, name: installation.name, evidence };
    }),
  );
}
