import { test } from "node:test";
import assert from "node:assert/strict";
import { runSetInstall } from "../ui/scope-install.js";
import type { EnvironmentOptions } from "../features/environment/operations.js";

function fixture() {
  const calls: { action: string; options: EnvironmentOptions }[] = [];
  const asset = {
    id: "asset",
    name: "review",
    origin: { type: "repo", slug: "dashboard" },
  };
  const context = {
    write: () => {},
    environment: async (action: string, options: EnvironmentOptions) => {
      calls.push({ action, options });
      return action === "sets-preview"
        ? { assets: [asset], selectedAssetIds: [] }
        : { status: "applied", events: [] };
    },
  };
  return { context, calls, asset };
}

test("scope install requires a mode outside a terminal and explicit modes never prompt", async () => {
  const f = fixture();
  await assert.rejects(
    runSetInstall(
      f.context,
      { origin: "repo/dashboard" },
      { interactive: false },
    ),
    /--mode/,
  );
  assert.deepEqual(f.calls, []);
  await runSetInstall(
    f.context,
    { origin: "repo/dashboard", mode: "all" },
    {
      interactive: false,
      mode: async () => {
        throw new Error("Must not prompt");
      },
    },
  );
  assert.deepEqual(f.calls, [
    {
      action: "sets-install",
      options: { origin: "repo/dashboard", mode: "all" },
    },
  ]);
});

test("scope install prompts for a mode and custom selection applies once", async () => {
  const f = fixture();
  await runSetInstall(
    f.context,
    { origin: "repo/dashboard" },
    {
      interactive: true,
      mode: async () => "custom",
      assets: async (assets) => {
        assert.deepEqual(assets, [f.asset]);
        return [f.asset.id];
      },
    },
  );
  assert.deepEqual(
    f.calls.map((call) => call.action),
    ["sets-preview", "sets-install-custom"],
  );
  assert.deepEqual(f.calls[1]!.options.assetIds, [f.asset.id]);
  f.calls.length = 0;
  await runSetInstall(
    f.context,
    { origin: "repo/dashboard" },
    { interactive: true, mode: async () => "recommended" },
  );
  assert.deepEqual(f.calls, [
    {
      action: "sets-install",
      options: { origin: "repo/dashboard", mode: "recommended" },
    },
  ]);
});

test("empty or cancelled custom selection never writes", async () => {
  const f = fixture();
  await runSetInstall(
    f.context,
    { origin: "repo/dashboard" },
    { interactive: true, mode: async () => "custom", assets: async () => [] },
  );
  assert.deepEqual(
    f.calls.map((call) => call.action),
    ["sets-preview"],
  );
  f.calls.length = 0;
  await assert.rejects(
    runSetInstall(
      f.context,
      { origin: "repo/dashboard" },
      {
        interactive: true,
        mode: async () => "custom",
        assets: async () => {
          throw new Error("cancelled");
        },
      },
    ),
    /cancelled/,
  );
  assert.deepEqual(
    f.calls.map((call) => call.action),
    ["sets-preview"],
  );
});
