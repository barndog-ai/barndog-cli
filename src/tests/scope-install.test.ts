import { expect, test } from "vitest";
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
  await expect(
    runSetInstall(
      f.context,
      { origin: "repo/dashboard" },
      { interactive: false },
    ),
  ).rejects.toThrow(/--mode/);
  expect(f.calls).toStrictEqual([]);
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
  expect(f.calls).toStrictEqual([
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
        expect(assets).toStrictEqual([f.asset]);
        return [f.asset.id];
      },
    },
  );
  expect(f.calls.map((call) => call.action)).toStrictEqual([
    "sets-preview",
    "sets-install-custom",
  ]);
  expect(f.calls[1]!.options.assetIds).toStrictEqual([f.asset.id]);
  f.calls.length = 0;
  await runSetInstall(
    f.context,
    { origin: "repo/dashboard" },
    { interactive: true, mode: async () => "recommended" },
  );
  expect(f.calls).toStrictEqual([
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
  expect(f.calls.map((call) => call.action)).toStrictEqual(["sets-preview"]);
  f.calls.length = 0;
  await expect(
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
  ).rejects.toThrow(/cancelled/);
  expect(f.calls.map((call) => call.action)).toStrictEqual(["sets-preview"]);
});
