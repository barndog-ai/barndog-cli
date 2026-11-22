import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, test, vi, type TestContext } from "vitest";

import { barndogPaths } from "../config/paths.js";
import {
  refreshUpdateCheck,
  updateCheck,
} from "../features/update-check/index.js";
import { HTTP_STATUS } from "../shared/constants.js";
import { renderUpdateNotice } from "../ui/update.js";
import { testRuntime } from "./runtime.js";

/** A home where BarnDog is set up, with no environment, so CI doesn't turn the check off. */
async function setUp(t: TestContext, env: Record<string, string> = {}) {
  const home = await mkdtemp(join(tmpdir(), "barndog-update-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const runtime = testRuntime(home, { env });
  const paths = barndogPaths(home);
  await mkdir(dirname(paths.settings), { recursive: true });
  await writeFile(paths.settings, "harnesses: []\n");

  return { home, runtime, paths };
}

const registry =
  (tags: unknown, status = 200): typeof fetch =>
  async () =>
    new Response(JSON.stringify(tags), { status });

const offline: typeof fetch = async () => {
  throw new TypeError("fetch failed");
};

test("a newer latest version is reported, and the registry isn't asked again for a day", async (t) => {
  const { runtime, paths } = await setUp(t);
  expect(await updateCheck("0.2.1", runtime)).toStrictEqual({
    update: undefined,
    due: true,
  });

  const urls: string[] = [];
  await refreshUpdateCheck(runtime, async (url) => {
    urls.push(String(url));

    return new Response(
      JSON.stringify({ latest: "0.3.0", next: "0.4.0-rc.1" }),
    );
  });

  expect(urls).toStrictEqual([
    "https://registry.npmjs.org/-/package/barndog/dist-tags",
  ]);

  expect(await updateCheck("0.2.1", runtime)).toStrictEqual({
    update: { current: "0.2.1", version: "0.3.0", tag: "latest" },
    due: false,
  });

  expect(await updateCheck("0.3.0", runtime)).toStrictEqual({
    update: undefined,
    due: false,
  });

  expect(await updateCheck("not-a-version", runtime)).toMatchObject({
    update: undefined,
  });

  // A day later the cached answer is due for another check.
  const cache = JSON.parse(await readFile(paths.updateCheck, "utf8")) as {
    checkedAt: string;
  };

  await writeFile(
    paths.updateCheck,
    JSON.stringify({
      ...cache,
      checkedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    }),
  );

  expect(await updateCheck("0.3.0", runtime)).toMatchObject({ due: true });
});

test("someone on a prerelease also hears about newer prereleases", async (t) => {
  const { runtime } = await setUp(t);
  await refreshUpdateCheck(
    runtime,
    registry({ latest: "0.3.0", next: "0.4.0-rc.1" }),
  );

  expect((await updateCheck("0.4.0-rc.0", runtime))?.update).toStrictEqual({
    current: "0.4.0-rc.0",
    version: "0.4.0-rc.1",
    tag: "next",
  });

  expect((await updateCheck("0.3.1-rc.0", runtime))?.update).toMatchObject({
    version: "0.4.0-rc.1",
  });

  expect((await updateCheck("0.2.1", runtime))?.update).toMatchObject({
    version: "0.3.0",
    tag: "latest",
  });

  // Once the release is out, it beats the prerelease that led up to it.
  await refreshUpdateCheck(
    runtime,
    registry({ latest: "0.4.0", next: "0.4.0-rc.1" }),
  );

  expect((await updateCheck("0.4.0-rc.0", runtime))?.update).toMatchObject({
    version: "0.4.0",
    tag: "latest",
  });
});

test("the entry script refreshes the cache of the home it's given", async (t) => {
  const { home, runtime } = await setUp(t);
  const argv = process.argv;
  vi.stubGlobal("fetch", registry({ latest: "9.0.0" }));
  process.argv = [String(argv[0]), "update-check.js", home];
  try {
    await import("../entry/update-check.js");
  } finally {
    process.argv = argv;
    vi.unstubAllGlobals();
  }

  expect((await updateCheck("0.2.1", runtime))?.update).toMatchObject({
    version: "9.0.0",
  });
});

test("a failed check keeps the earlier answer and still waits a day", async (t) => {
  const { runtime, paths } = await setUp(t);
  await refreshUpdateCheck(runtime, registry({ latest: "0.3.0" }));

  for (const failing of [
    offline,
    registry({ error: "Not found" }, HTTP_STATUS.notFound),
    registry({ unexpected: true }),
  ]) {
    await refreshUpdateCheck(runtime, failing);
    expect(await updateCheck("0.2.1", runtime)).toStrictEqual({
      update: { current: "0.2.1", version: "0.3.0", tag: "latest" },
      due: false,
    });
  }

  await writeFile(paths.updateCheck, "not json");
  expect(await updateCheck("0.2.1", runtime)).toStrictEqual({
    update: undefined,
    due: true,
  });
});

test("the check is off in CI, by opt-out, and while BarnDog isn't set up", async (t) => {
  for (const env of [
    { CI: "true" } as Record<string, string>,
    { BARNDOG_NO_UPDATE_CHECK: "1" },
    { NO_UPDATE_NOTIFIER: "1" },
  ]) {
    const { runtime } = await setUp(t, env);
    expect(await updateCheck("0.2.1", runtime)).toBeUndefined();
  }

  const { runtime, paths } = await setUp(t, { BARNDOG_NO_UPDATE_CHECK: " " });
  expect(await updateCheck("0.2.1", runtime)).toBeDefined();

  await rm(paths.settings);
  expect(await updateCheck("0.2.1", runtime)).toBeUndefined();
});

test("the notice names the version and the commands that install it", () => {
  const notice = stripVTControlCharacters(
    renderUpdateNotice({
      current: "0.4.0-rc.0",
      version: "0.4.0-rc.1",
      tag: "next",
    }).join("\n"),
  );

  expect(notice).toBe(
    [
      "",
      "A new BarnDog CLI is available: 0.4.0-rc.0 → 0.4.0-rc.1",
      "Next: npm install -g barndog@next, then barndog sync",
    ].join("\n"),
  );
});
