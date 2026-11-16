import type { RuntimeContext } from "../runtime.js";

/** A test owns its home; the other inputs can be replaced without mutating process state. */
export function testRuntime(
  home: string,
  overrides: Partial<RuntimeContext> = {},
): RuntimeContext {
  return {
    home,
    cwd: process.cwd(),
    env: { ...process.env },
    platform: process.platform,
    ...overrides,
  };
}
