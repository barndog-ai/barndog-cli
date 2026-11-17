import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type TestContext } from "vitest";
import {
  assertCommandAvailable,
  currentSetupMode,
} from "../commands/availability.js";
import { saveSettings } from "../config/settings.js";
import { CliError } from "../errors.js";
import { updateCredentials } from "../features/auth/credentials.js";
import type { RuntimeContext } from "../runtime.js";
import { testRuntime } from "./runtime.js";

type Mode = "local" | "git" | "unconnected";

type StoredMode = Exclude<Mode, "unconnected">;

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const GIT_URL = "https://example.test/repo";
const SWITCH_HINT = "barndog init --server <url>";

async function setup(
  t: TestContext,
  mode: Mode,
): Promise<{ runtime: RuntimeContext; where: string; home: string }> {
  const home = await mkdtemp(join(tmpdir(), "barndog-availability-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  await saveSettings(
    {
      harnesses: [],
      ...(mode === "git"
        ? {
            gitWorkspace: {
              workspaceId: WORKSPACE_ID,
              url: GIT_URL,
              branch: "main",
            },
          }
        : {}),
      ...(mode === "local"
        ? { localWorkspace: { workspaceId: WORKSPACE_ID, path: home } }
        : {}),
    },
    home,
  );

  return {
    runtime: testRuntime(home),
    home,
    where:
      mode === "git"
        ? `a Git repo (${GIT_URL})`
        : `a folder on this machine (${home})`,
  };
}

async function refusal(promise: Promise<void>): Promise<CliError> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(CliError);

  return error as CliError;
}

/** What the message says each cloud-only command does, as the user reads it. */
const cloudOnly: { words: string[]; message: string }[] = [
  {
    words: ["whoami"],
    message: "`barndog whoami` shows your BarnDog Cloud Workspace sign-in",
  },
  {
    words: ["auth", "status"],
    message: "`barndog auth status` shows your BarnDog Cloud Workspace sign-in",
  },
  {
    words: ["open"],
    message: "`barndog open` opens the BarnDog Cloud Workspace in your browser",
  },
  {
    words: ["people", "list"],
    message: "`barndog people list` needs a BarnDog Cloud Workspace",
  },
  {
    words: ["login"],
    message: "`barndog login` signs in to a BarnDog Cloud Workspace",
  },
  {
    words: ["skills", "promote"],
    message: "`barndog skills promote` needs a BarnDog Cloud Workspace",
  },
  {
    words: ["mcp", "create"],
    message: "`barndog mcp create` needs a BarnDog Cloud Workspace",
  },
];

for (const mode of ["local", "git"] as const satisfies StoredMode[]) {
  test(`${mode} mode reports its setup mode`, async (t) => {
    const { runtime } = await setup(t, mode);

    expect(await currentSetupMode(runtime)).toBe(mode);
  });

  for (const { words, message } of cloudOnly) {
    test(`${mode} mode refuses \`${words.join(" ")}\` and points at barndog init --server`, async (t) => {
      const { runtime, where } = await setup(t, mode);
      const error = await refusal(assertCommandAvailable(words, {}, runtime));

      const stay =
        mode === "local" ? " Your local assets stay active if you switch." : "";

      expect(error.message).toContain(message);
      expect(error.message).toContain(
        `but this machine keeps its assets in ${where}.${stay}`,
      );

      expect(error.hint).toBe(SWITCH_HINT);
    });
  }

  test(`${mode} mode lets \`login --server\` through`, async (t) => {
    const { runtime } = await setup(t, mode);

    await expect(
      assertCommandAvailable(
        ["login"],
        { server: "https://example.test" },
        runtime,
      ),
    ).resolves.toBeUndefined();
  });

  test(`${mode} mode lets \`skills promote --origin local\` through`, async (t) => {
    const { runtime } = await setup(t, mode);

    await expect(
      assertCommandAvailable(
        ["skills", "promote"],
        { origin: "local" },
        runtime,
      ),
    ).resolves.toBeUndefined();
  });

  test(`${mode} mode still refuses \`skills promote\` from another origin`, async (t) => {
    const { runtime } = await setup(t, mode);
    const error = await refusal(
      assertCommandAvailable(["skills", "promote"], { origin: "org" }, runtime),
    );

    expect(error.hint).toBe(SWITCH_HINT);
  });

  test(`${mode} mode refuses \`logout\` when no one is signed in`, async (t) => {
    const { runtime, where } = await setup(t, mode);
    const error = await refusal(
      assertCommandAvailable(["logout"], {}, runtime),
    );

    expect(error.message).toBe(
      `You aren't signed in. This machine keeps its assets in ${where}, so it doesn't need a sign-in.`,
    );

    expect(error.hint).toBeUndefined();
  });

  test(`${mode} mode allows \`logout\` once a server is selected`, async (t) => {
    const { runtime } = await setup(t, mode);
    await updateCredentials(runtime, (credentials) => {
      credentials.selectedServer = "https://example.test";
    });

    await expect(
      assertCommandAvailable(["logout"], {}, runtime),
    ).resolves.toBeUndefined();
  });
}

test("local mode refuses review commands and says to edit the folder and sync", async (t) => {
  const { runtime, home } = await setup(t, "local");

  for (const words of [
    ["push"],
    ["pull"],
    ["resolve"],
    ["skills", "versions"],
    ["hooks", "create"],
    ["mcp", "versions"],
  ]) {
    const error = await refusal(assertCommandAvailable(words, {}, runtime));

    expect(error.message).toBe(
      `\`barndog ${words.join(" ")}\` works with shared versions and reviews, which assets in a local folder don't have. Edit them directly in ${home}, then sync.`,
    );

    expect(error.hint).toBe("barndog sync");
  }
});

test("git mode allows the review commands", async (t) => {
  const { runtime } = await setup(t, "git");

  for (const words of [["push"], ["pull"], ["skills", "versions"]]) {
    await expect(
      assertCommandAvailable(words, {}, runtime),
    ).resolves.toBeUndefined();
  }
});

test("git mode explains that reviews happen as pull requests, for skills and hooks alike", async (t) => {
  const { runtime, where } = await setup(t, "git");

  for (const words of [
    ["skills", "changes", "list"],
    ["hooks", "changes", "apply"],
  ]) {
    const error = await refusal(assertCommandAvailable(words, {}, runtime));

    expect(error.message).toBe(
      `Reviews happen as pull requests on your Git host, because this machine keeps its assets in ${where}.`,
    );

    expect(error.hint).toBe("barndog status");
  }
});

test("local mode refuses review changes as a Cloud-only command", async (t) => {
  const { runtime, where } = await setup(t, "local");
  const error = await refusal(
    assertCommandAvailable(["skills", "changes", "list"], {}, runtime),
  );

  expect(error.message).toBe(
    `\`barndog skills changes list\` needs a BarnDog Cloud Workspace, but this machine keeps its assets in ${where}. Your local assets stay active if you switch.`,
  );

  expect(error.hint).toBe(SWITCH_HINT);
});

test("an unconnected machine can run every command", async (t) => {
  const { runtime } = await setup(t, "unconnected");

  expect(await currentSetupMode(runtime)).toBeUndefined();
  for (const words of [
    ["whoami"],
    ["auth", "status"],
    ["open"],
    ["people", "list"],
    ["skills", "changes", "list"],
    ["login"],
    ["skills", "promote"],
    ["push"],
  ]) {
    await expect(
      assertCommandAvailable(words, {}, runtime),
    ).resolves.toBeUndefined();
  }
});

// Like a Cloud-connected machine, a settings file without a Git or local workspace
// leaves `logout` to the command itself, whether or not a credential is saved.
test("logout on a machine with settings but no workspace is left to the command", async (t) => {
  const { runtime } = await setup(t, "unconnected");

  await expect(
    assertCommandAvailable(["logout"], {}, runtime),
  ).resolves.toBeUndefined();
});

test("logout with no settings file at all checks the selected credential", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "barndog-availability-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const runtime = testRuntime(home);

  expect(await currentSetupMode(runtime)).toBeUndefined();
  const error = await refusal(assertCommandAvailable(["logout"], {}, runtime));

  expect(error.message).toBe("You aren't signed in.");
  expect(error.hint).toBeUndefined();

  await updateCredentials(runtime, (credentials) => {
    credentials.selectedServer = "https://example.test";
  });

  await expect(
    assertCommandAvailable(["logout"], {}, runtime),
  ).resolves.toBeUndefined();
});
