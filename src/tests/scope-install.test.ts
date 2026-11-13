import { expect, test } from "vitest";
import { runSetInstall } from "../ui/scope-install.js";

function fixture() {
  const calls: { action: string; options: unknown }[] = [];
  const asset = {
    id: "asset",
    name: "review",
    origin: { type: "repo", slug: "dashboard" },
  };

  const applied = () => ({ status: "applied" as const, events: [] });
  const context = {
    write: () => {},
    installSet: async (options: object) => {
      calls.push({ action: "install", options });

      return applied();
    },
    previewSet: async (origin: string) => {
      calls.push({ action: "preview", options: { origin } });

      return { assets: [asset], selectedAssetIds: [] } as never;
    },
    installSetAssets: async (options: object) => {
      calls.push({ action: "install-assets", options });

      return applied();
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
      action: "install",
      options: { origin: "repo/dashboard", mode: "all", resolution: undefined },
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
    "preview",
    "install-assets",
  ]);

  expect(f.calls[1]!.options).toStrictEqual({
    origin: "repo/dashboard",
    assetIds: [f.asset.id],
  });

  f.calls.length = 0;
  await runSetInstall(
    f.context,
    { origin: "repo/dashboard" },
    { interactive: true, mode: async () => "recommended" },
  );

  expect(f.calls).toStrictEqual([
    {
      action: "install",
      options: {
        origin: "repo/dashboard",
        mode: "recommended",
        resolution: undefined,
      },
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

  expect(f.calls.map((call) => call.action)).toStrictEqual(["preview"]);
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

  expect(f.calls.map((call) => call.action)).toStrictEqual(["preview"]);
});
