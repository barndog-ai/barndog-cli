import { expect, test, vi, type TestContext } from "vitest";
import { hookMetadata } from "@barndog-ai/api-contract/package";
import { readSettings } from "../config/settings.js";
import { localRepoSource } from "../features/workspace/repo-source.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { addHook } from "../ui/add-hook.js";
import type { AddContext, AddOptions } from "../ui/add-asset.js";
import { CliError } from "../errors.js";
import { fetchRemote, type RemoteRepo } from "../features/imports/remote.js";
import { saveSettings } from "../config/settings.js";
import { GIT_MODE } from "../features/workspace/snapshot.js";
import { testRuntime } from "./runtime.js";
import { packages } from "./cloud.js";

vi.mock("../features/imports/remote.js", async (original) => ({
  ...(await original<typeof import("../features/imports/remote.js")>()),
  fetchRemote: vi.fn(),
}));

function remote(files: { path: string; text: string }[]): RemoteRepo {
  const blobs = new Map<string, Buffer>();
  const entries = files.map((file) => {
    const data = Buffer.from(file.text);
    const hash = createHash("sha1").update(data).digest("hex");
    blobs.set(hash, data);

    return { path: file.path, hash, mode: GIT_MODE.file };
  });

  return {
    url: "https://example.test/hooks.git",
    ref: null,
    commit: "a".repeat(40),
    path: "",
    blobs,
    snapshot: {
      entries,
      readBlobs: async (hashes) =>
        new Map(hashes.map((hash) => [hash, blobs.get(hash)!])),
    },
  };
}

async function context(t: {
  onTestFinished: (fn: () => Promise<void>) => void;
}): Promise<AddContext> {
  const home = await mkdtemp(join(tmpdir(), "barndog-hook-prompts-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  await saveSettings({ harnesses: ["claude", "opencode"] }, home);

  return {
    runtime: testRuntime(home),
    interactive: true,
    write: vi.fn(),
    prompts: {
      chooseMany: vi.fn(),
      chooseOne: vi.fn().mockResolvedValue("scripts/one.sh"),
      text: vi.fn().mockImplementation(async (_, fallback) => fallback),
      yes: vi.fn().mockResolvedValue(true),
      paste: vi.fn(),
    },
  };
}

for (const scripts of [1, 2]) {
  for (const matcher of ["", "Bash"]) {
    test(`draft import asks for scripts and matchers (${scripts}/${matcher})`, async (t) => {
      const ctx = await context(t);
      const source = remote([
        { path: "scripts/one.sh", text: "echo one\n" },
        ...(scripts === 2
          ? [{ path: "scripts/two.sh", text: "echo two\n" }]
          : []),
      ]);

      vi.mocked(fetchRemote).mockImplementation(async (_, __, use) =>
        use(source),
      );

      vi.mocked(ctx.prompts.chooseOne).mockResolvedValue("scripts/two.sh");
      vi.mocked(ctx.prompts.chooseMany)
        .mockResolvedValueOnce(["claude", "codex", "invalid"])
        .mockResolvedValueOnce(["PostToolUse"])
        .mockResolvedValueOnce(["SessionStart"]);

      vi.mocked(ctx.prompts.text).mockImplementation(
        async (question, fallback) => {
          if (question.includes("matcher")) {
            return question.startsWith("PostToolUse") ? matcher : "";
          }

          return fallback ?? "hook";
        },
      );

      await addHook(
        source.url,
        { updates: "fork", as: "imported-hook", description: "Imported" },
        ctx,
      );

      expect(ctx.write).toHaveBeenCalledWith(
        expect.stringContaining("Added imported-hook"),
      );

      expect(ctx.prompts.chooseOne).toHaveBeenCalledTimes(
        scripts === 2 ? 2 : 0,
      );

      const settings = (await readSettings(ctx.runtime.home))!;
      const asset = (
        await localRepoSource(settings.localWorkspace!, ctx.runtime).model()
      ).assets.find((asset) => asset.name === "imported-hook")!;

      const manifest = hookMetadata(asset.entries);
      const selectedScript = scripts === 2 ? "two.sh" : "one.sh";
      expect(manifest.description).toBe("Imported");
      expect(manifest.implementations.claude!.scripts).toEqual([
        selectedScript,
      ]);

      expect(manifest.implementations.codex!.scripts).toEqual([selectedScript]);
      expect(manifest.implementations.claude!.events.PostToolUse).toEqual([
        {
          ...(matcher ? { matcher } : {}),
          hooks: [
            {
              type: "command",
              command: expect.stringContaining(
                `\${BARNDOG_HOOK_ROOT}/${selectedScript}`,
              ),
            },
          ],
        },
      ]);

      expect(manifest.implementations.codex!.events.SessionStart).toEqual([
        {
          hooks: [
            {
              type: "command",
              command: expect.stringContaining(
                `\${BARNDOG_HOOK_ROOT}/${selectedScript}`,
              ),
            },
          ],
        },
      ]);

      expect(
        asset.entries
          .find((file) => file.path === selectedScript)!
          .data.toString("utf8"),
      ).toBe(scripts === 2 ? "echo two\n" : "echo one\n");
    });
  }
}

for (const stop of ["events", "confirmation", "noninteractive"] as const) {
  test(`draft import stops without writing when ${stop} prevents import`, async (t) => {
    const ctx = await context(t);
    const source = remote([{ path: "scripts/one.sh", text: "echo one\n" }]);
    vi.mocked(fetchRemote).mockImplementation(async (_, __, use) =>
      use(source),
    );

    if (stop === "noninteractive") {
      ctx.interactive = false;
    }

    vi.mocked(ctx.prompts.chooseMany)
      .mockResolvedValueOnce(["claude"])
      .mockResolvedValueOnce(stop === "events" ? [] : ["SessionStart"]);

    vi.mocked(ctx.prompts.yes).mockResolvedValue(false);
    await expect(addHook(source.url, { updates: "fork" }, ctx)).rejects.toThrow(
      stop === "events"
        ? "No events"
        : stop === "noninteractive"
          ? "need events chosen"
          : "Nothing was added",
    );

    expect(
      (await readSettings(ctx.runtime.home))!.localWorkspace,
    ).toBeUndefined();
  });
}

/** A repository with three packaged Hooks, in folders one, two and three. */
function threeHooks() {
  return remote(
    ["one", "two", "three"].flatMap((root) =>
      packages.hook.map((file) => ({
        path: `${root}/${file.path}`,
        text: Buffer.from(file.content, "base64")
          .toString("utf8")
          .replaceAll("release-notes", `${root}-hook`)
          .replaceAll("echo checked", `echo ${root}`),
      })),
    ),
  );
}

async function addedHooks(ctx: AddContext) {
  const settings = await readSettings(ctx.runtime.home);
  if (!settings?.localWorkspace) {
    return [];
  }

  const { assets } = await localRepoSource(
    settings.localWorkspace,
    ctx.runtime,
  ).model();

  return assets.map((asset) => ({
    name: asset.name,
    manifest: hookMetadata(asset.entries).name,
  }));
}

async function addFromThree(
  t: TestContext,
  options: AddOptions,
  { interactive = true } = {},
) {
  const ctx = await context(t);
  const source = threeHooks();
  vi.mocked(fetchRemote).mockImplementation(async (_, __, use) => use(source));
  ctx.interactive = interactive;

  const error: unknown = await addHook(
    source.url,
    { updates: "fork", ...options },
    ctx,
  ).then(
    () => undefined,
    (caught: unknown) => caught,
  );

  return { ctx, source, error };
}

test("several packaged Hooks are offered together, and every ticked one is added", async (t) => {
  const ctx = await context(t);
  const source = threeHooks();
  vi.mocked(fetchRemote).mockImplementation(async (_, __, use) => use(source));
  vi.mocked(ctx.prompts.chooseMany).mockResolvedValue(["one", "three"]);

  await addHook(source.url, { updates: "fork" }, ctx);

  const [message, choices] = vi.mocked(ctx.prompts.chooseMany).mock.lastCall!;
  expect(message).toBe("Which Hooks do you want?");
  expect(choices.map((choice) => choice.short)).toEqual([
    "one-hook",
    "two-hook",
    "three-hook",
  ]);

  expect(await addedHooks(ctx)).toEqual([
    { name: "one-hook", manifest: "one-hook" },
    { name: "three-hook", manifest: "three-hook" },
  ]);

  expect(ctx.write).toHaveBeenCalledWith("✔ Added one-hook");
  expect(ctx.write).toHaveBeenCalledWith("✔ Added three-hook");
});

test("--only adds exactly the Hooks it names, by name or folder", async (t) => {
  const { ctx, error } = await addFromThree(t, {
    only: ["two-hook", "three"],
  });

  expect(error).toBeUndefined();
  expect((await addedHooks(ctx)).map((hook) => hook.name)).toEqual([
    "three-hook",
    "two-hook",
  ]);

  expect(ctx.prompts.chooseMany).not.toHaveBeenCalled();
});

test("--only with a name the repository doesn't have adds nothing and lists the names it has", async (t) => {
  const { ctx, source, error } = await addFromThree(t, {
    only: ["two-hook", "tow-hook"],
  });

  expect(error).toBeInstanceOf(CliError);
  expect(error).toMatchObject({
    message: `${source.url} has no Hook named tow-hook. It has one-hook, two-hook, three-hook.`,
    hint: `barndog hooks add ${source.url} --only <name>`,
  });

  expect(await addedHooks(ctx)).toEqual([]);
});

test("--all adds every packaged Hook without asking", async (t) => {
  const { ctx, error } = await addFromThree(t, { all: true });

  expect(error).toBeUndefined();
  expect((await addedHooks(ctx)).map((hook) => hook.name)).toEqual([
    "one-hook",
    "three-hook",
    "two-hook",
  ]);

  expect(ctx.prompts.chooseMany).not.toHaveBeenCalled();
});

test("without a terminal, several Hooks need --only or --all", async (t) => {
  const { ctx, source, error } = await addFromThree(
    t,
    {},
    { interactive: false },
  );

  expect(error).toBeInstanceOf(CliError);
  expect(error).toMatchObject({
    message: `${source.url} has 3 Hooks: one-hook, two-hook, three-hook.`,
    hint: `barndog hooks add ${source.url} --only <name>`,
  });

  expect(await addedHooks(ctx)).toEqual([]);
});

test("ticking no Hooks adds nothing", async (t) => {
  const ctx = await context(t);
  const source = threeHooks();
  vi.mocked(fetchRemote).mockImplementation(async (_, __, use) => use(source));
  vi.mocked(ctx.prompts.chooseMany).mockResolvedValue([]);

  await expect(addHook(source.url, { updates: "fork" }, ctx)).rejects.toThrow(
    new CliError("No Hooks were chosen, so nothing was added."),
  );

  expect(await addedHooks(ctx)).toEqual([]);
});

test("--as renames one chosen Hook and is refused for several", async (t) => {
  const renamed = await addFromThree(t, { only: ["two-hook"], as: "lint" });

  expect(renamed.error).toBeUndefined();
  expect(await addedHooks(renamed.ctx)).toEqual([
    { name: "lint", manifest: "lint" },
  ]);

  const several = await addFromThree(t, { all: true, as: "lint" });

  expect(several.error).toBeInstanceOf(CliError);
  expect(several.error).toHaveProperty(
    "message",
    "--as renames one Hook, so choose exactly one.",
  );

  expect(await addedHooks(several.ctx)).toEqual([]);
});

test("--only can't choose from loose scripts, which have no Hook names yet", async (t) => {
  const ctx = await context(t);
  const source = remote([
    { path: "scripts/one.sh", text: "#!/bin/sh\necho one\n" },
  ]);

  vi.mocked(fetchRemote).mockImplementation(async (_, __, use) => use(source));

  await expect(
    addHook(source.url, { updates: "fork", only: ["one"] }, ctx),
  ).rejects.toMatchObject({
    message: `${source.url} has no packaged Hooks to choose from, only scripts and settings to build one from.`,
    hint: `barndog hooks add ${source.url}`,
  });

  expect(await addedHooks(ctx)).toEqual([]);
});

test("a Hook written from loose scripts starts with the tools BarnDog manages ticked", async (t) => {
  const ctx = await context(t);
  const source = remote([{ path: "scripts/one.sh", text: "echo one\n" }]);
  vi.mocked(fetchRemote).mockImplementation(async (_, __, use) => use(source));
  vi.mocked(ctx.prompts.chooseMany)
    .mockResolvedValueOnce(["claude"])
    .mockResolvedValueOnce(["SessionStart"]);

  await addHook(
    source.url,
    { updates: "fork", as: "imported-hook", description: "Imported" },
    ctx,
  );

  const [message, choices] = vi.mocked(ctx.prompts.chooseMany).mock.calls[0]!;
  expect(message).toBe("Which coding tools should this Hook support?");
  expect(choices.map((choice) => [choice.value, choice.checked])).toStrictEqual(
    [
      ["claude", true],
      ["codex", false],
      ["cursor", false],
    ],
  );
});
