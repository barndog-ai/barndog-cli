import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { harnesses, adapters, type DetectedHarness } from "./registry.js";

type DetectionOptions = {
  home?: string;
  path?: string;
  platform?: NodeJS.Platform;
  appDirectories?: string[];
};

async function exists(path: string, directory = false): Promise<boolean> {
  try {
    const info = await stat(path);
    if (directory) return info.isDirectory();
    await access(path, constants.X_OK);
    return info.isFile();
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR", "EACCES"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return false;
    throw error;
  }
}

/** Inspect installation evidence; never execute harnesses or infer installation from skill directories. */
export async function detectHarnesses(
  options: DetectionOptions = {},
): Promise<DetectedHarness[]> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const directories = (options.path ?? process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean);
  const appDirectories = options.appDirectories ?? [
    "/Applications",
    join(home, "Applications"),
  ];
  const extensions = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  return Promise.all(
    harnesses.map(async (id) => {
      const installation = adapters[id];
      let evidence: string | null = null;
      for (const directory of directories) {
        for (const command of installation.commands) {
          for (const extension of extensions) {
            const candidate = join(directory, `${command}${extension}`);
            if (await exists(candidate)) {
              evidence = candidate;
              break;
            }
          }
          if (evidence) break;
        }
        if (evidence) break;
      }
      if (!evidence && platform === "darwin") {
        for (const directory of appDirectories) {
          const candidate = join(directory, installation.macApp);
          if (await exists(join(candidate, "Contents", "MacOS"), true)) {
            evidence = candidate;
            break;
          }
        }
      }
      return { id, name: installation.name, evidence };
    }),
  );
}
