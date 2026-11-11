import { fileURLToPath } from "node:url";

// Tests import TypeScript from src/, but a few start Node processes, and those
// need the JavaScript that src/tests/global-setup.ts builds into dist/.
export const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

export const builtRoot = fileURLToPath(new URL("../../dist/", import.meta.url));

export function built(path: string) {
  return builtRoot + path;
}
