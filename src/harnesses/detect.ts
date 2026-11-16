import { harnesses, adapters, type DetectedHarness } from "./registry.js";
import type { RuntimeContext } from "../runtime.js";
import { findExecutable, installedApplication } from "../platform.js";

/** Inspect installation evidence; never execute harnesses or infer installation from skill directories. */
export async function detectHarnesses(
  runtime: RuntimeContext,
  options: { appDirectories?: string[] } = {},
): Promise<DetectedHarness[]> {
  return Promise.all(
    harnesses.map(async (id) => {
      const installation = adapters[id];
      let evidence: string | null = null;
      for (const command of installation.commands) {
        evidence = await findExecutable(command, runtime);
        if (evidence) {
          break;
        }
      }

      evidence ??= await installedApplication(
        installation.desktopApp,
        runtime,
        options.appDirectories,
      );

      return { id, name: installation.name, evidence };
    }),
  );
}
