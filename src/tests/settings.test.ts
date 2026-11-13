import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { stringify } from "yaml";

import { readSettings } from "../config/settings.js";

const workspaceId = "729b9d5a-4a8c-4aa7-9b8d-975a55ac373e";
const base = { version: 2, harnesses: ["claude"], skills: [] };

describe("readSettings for version 2", () => {
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "barndog-settings-"));
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const read = async (settings: Record<string, unknown>) => {
    const path = join(home, "config.yaml");
    await writeFile(path, stringify({ ...base, ...settings }));
    return readSettings(home, path);
  };

  test.each([
    [{ skills: [{ kind: "api" }] }, "invalid skill selection"],
    [{ connection: { server: "ftp://x" } }, "invalid server connection"],
    [
      { gitWorkspace: { url: "-x", branch: "main", workspaceId } },
      "invalid Git workspace",
    ],
    [
      { localWorkspace: { path: "relative", workspaceId } },
      "invalid local workspace",
    ],
    [{ environment: {} }, "invalid asset selection"],
    [{ knowledge: "yes" }, "Invalid knowledge integration setting"],
    [{ knowledge: null }, "Invalid knowledge integration setting"],
    [{ localNames: { "not-a-uuid": "x" } }, "localNames maps asset IDs"],
    [
      { localNames: { [workspaceId]: "Bad Name" } },
      "localNames maps asset IDs",
    ],
  ])("rejects %j", async (settings, message) => {
    await expect(read(settings)).rejects.toThrow(message);
  });

  test("leaves absent parts out and keeps keys it doesn't know", async () => {
    const settings = await read({ knowledge: false, future: 1 });
    expect(settings).toEqual({ ...base, knowledge: false, future: 1 });
    expect(settings && "connection" in settings).toBe(false);
  });

  test("reads every optional part", async () => {
    const settings = await read({
      gitWorkspace: { url: "https://x/r.git", branch: "main", workspaceId },
      localNames: { [workspaceId]: "code-review" },
      knowledge: true,
    });
    expect(settings).toMatchObject({
      gitWorkspace: { url: "https://x/r.git", branch: "main", workspaceId },
      localNames: { [workspaceId]: "code-review" },
      knowledge: true,
    });
  });
});
