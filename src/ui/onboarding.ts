import { environmentChooser } from "./environment-onboarding.js";
import { authStatus, configuredServer } from "../features/auth/session.js";
import {
  chooseConnection,
  chooseLocalAssets,
  chooseMoveTarget,
  type LocalAssetChoice,
  type SetupChoice,
} from "./connection.js";
import {
  cloudMoveTargets,
  moveLocalAssets,
} from "../features/git-workspace/move.js";
import { localRepoSource } from "../features/git-workspace/source.js";
import { renderMove } from "./move.js";
import {
  checkRepositoryUrl,
  cloneOrigin,
  RepositoryAccessError,
  type RemoteHead,
} from "../features/git-workspace/git.js";
import {
  cloneGitWorkspace,
  connectGitWorkspace,
  createGitWorkspace,
  defaultLocalPath,
  inspectRepository,
  localWorkspace,
} from "../features/git-workspace/setup.js";
import { CliError } from "../errors.js";
import { selectionState } from "../config/environment.js";
import { LoginRequiredError } from "../features/auth/transport.js";
import { runLogin } from "./auth.js";
import type {
  ChooseEnvironment,
  EnvironmentChoices,
} from "../features/onboarding/environment.js";
import { synchronize } from "../features/environment/sync.js";
import { cleanUpIfInterrupted } from "../features/environment/transaction.js";
import { renderSyncOutput } from "./output.js";
import checkbox from "@inquirer/checkbox";
import confirm from "@inquirer/confirm";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { styleText } from "node:util";
import type { DetectedHarness, Harness } from "../harnesses/registry.js";
import {
  readSettings,
  settingsPath,
  type GitWorkspace,
  type Settings,
} from "../config/settings.js";
import {
  initialize,
  type ChosenWorkspace,
  type HarnessChoice,
} from "../features/onboarding/setup.js";
import { checkboxTheme, promptTheme, selected } from "./theme.js";
import { bold, dim, fields, heading, originLabel, table } from "./format.js";

const chooseHarnesses = (choices: HarnessChoice[]): Promise<Harness[]> => {
  const width = Math.max(...choices.map((choice) => choice.name.length));

  return checkbox<Harness>({
    loop: false,
    message: "Which coding tools should BarnDog manage?",
    choices: choices.map((choice) => ({
      value: choice.value,
      checked: choice.checked,
      short: choice.name,
      name: `${choice.name.padEnd(width)}  ${choice.evidence ? selected("detected") : dim("not found")}`,
      description: choice.evidence ?? undefined,
    })),
    theme: checkboxTheme,
  });
};

type Choose = typeof chooseHarnesses;

/** The source setup was last run with, offered as the default. */
function savedChoice(
  previous: Settings,
  server: string | undefined,
): SetupChoice | undefined {
  if (previous.gitWorkspace) {
    return { kind: "git", url: previous.gitWorkspace.url };
  }

  if (previous.localWorkspace) {
    return { kind: "local" };
  }

  return server ? { kind: "cloud", server } : undefined;
}

/** The source named by `--local`, `--repo` or `--server`, if any. */
function flagChoice(options: {
  local?: boolean;
  repo?: string;
  server?: string;
}): SetupChoice | undefined {
  if (options.local) {
    return { kind: "local" };
  }

  if (options.repo) {
    return { kind: "git", url: options.repo };
  }

  return options.server ? { kind: "cloud", server: options.server } : undefined;
}

/** Starting over always offers every source; a saved server is only the default. */
async function chooseSource(
  previous: Settings | null,
  home: string,
  choose: (current?: SetupChoice) => Promise<SetupChoice> = chooseConnection,
): Promise<SetupChoice> {
  const server = await configuredServer(home);
  if (!previous) {
    return server ? { kind: "cloud", server } : choose();
  }

  return choose(savedChoice(previous, server));
}

export async function runSetup(
  options: {
    restart?: boolean;
    server?: string;
    local?: boolean;
    repo?: string;
    browser?: boolean;
    chooseConnection?: (current?: SetupChoice) => Promise<SetupChoice>;
    confirmCreateRepo?: (url: string) => Promise<boolean>;
    confirmClone?: (url: string) => Promise<boolean>;
    chooseLocalAssets?: (count: number) => Promise<LocalAssetChoice>;
    chooseMoveTarget?: (
      targets: { value: string; name: string }[],
    ) => Promise<string>;
    confirmApply?: (settings: Settings) => Promise<boolean>;
    home?: string;
    interactive?: boolean;
    write?: (message: string) => void;
    confirmRestart?: () => Promise<boolean>;
    choose?: Choose;
    chooseEnvironment?: ChooseEnvironment;
    cwd?: string;
    detected?: DetectedHarness[];
  } = {},
): Promise<void> {
  const home = options.home ?? homedir();
  const write = options.write ?? console.log;
  const previous = await readSettings(home);
  if (previous) {
    write(`Configuration already exists at ${settingsPath(home)}.`);
    write("");
    if (!options.restart) {
      write(`To start setup again, run ${styleText("bold", "barndog init")}.`);

      return;
    }
  }

  const interactive =
    options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);

  if (!interactive) {
    throw new Error(
      `Onboarding requires an interactive terminal. Run ${styleText("bold", "barndog init", { stream: process.stderr })} in your terminal.`,
    );
  }

  if (previous) {
    const confirmed = await (
      options.confirmRestart ??
      (() =>
        confirm({
          message:
            "Set up again? Your current selection on this machine will be replaced. Choosing a different source removes what's installed from the current one.",
          default: false,
          theme: promptTheme,
        }))
    )();

    if (!confirmed) {
      write("Setup cancelled. Configuration was not changed.");

      return;
    }
  }

  write(`\n${heading("setup")}\n`);
  if (
    [options.local, options.server, options.repo].filter(Boolean).length > 1
  ) {
    throw new Error("--local, --repo and --server cannot be combined");
  }

  const choice: SetupChoice =
    flagChoice(options) ??
    (await chooseSource(previous, home, options.chooseConnection));

  const server = choice.kind === "cloud" ? choice.server : undefined;
  let workspace: ChosenWorkspace | undefined;
  let discardWorkspace: (() => void) | undefined;
  let keepWorkspace = () => {};

  if (choice.kind === "local") {
    const fresh = !existsSync(defaultLocalPath(home));
    const local = await localWorkspace(home);
    workspace = { kind: "local", local };
    // A folder made for this run shouldn't outlive a setup that didn't finish.
    if (fresh) {
      discardWorkspace = () =>
        rmSync(local.path, { recursive: true, force: true });

      keepWorkspace = cleanUpIfInterrupted(discardWorkspace);
    }
  }

  if (choice.kind === "git") {
    const url = checkRepositoryUrl(await cloneOrigin(choice.url));
    let head: RemoteHead = null;
    let cloned: GitWorkspace | null = null;
    try {
      head = await inspectRepository(url);
    } catch (error) {
      if (!(error instanceof RepositoryAccessError)) {
        throw error;
      }

      write(`${error.message}`);
      write(
        dim(
          "Git has to be able to clone this repo on this machine. Once it can, BarnDog manages it for you.",
        ),
      );

      const clone = await (
        options.confirmClone ??
        (() =>
          confirm({
            message: `Clone it now into ${join(home, ".barndog", "git")}? Git will ask for anything it needs.`,
            default: true,
            theme: promptTheme,
          }))
      )(url);

      if (!clone) {
        throw error;
      }

      cloned = await cloneGitWorkspace(url, home);
    }

    if (!head && !cloned) {
      const create = await (
        options.confirmCreateRepo ??
        ((target: string) =>
          confirm({
            message: `${target} is empty. Set it up as a BarnDog workspace?`,
            default: true,
            theme: promptTheme,
          }))
      )(url);

      if (!create) {
        throw new CliError("Setup stopped. The repository was not changed.");
      }
    }

    workspace = {
      kind: "git",
      git:
        cloned ??
        (head
          ? await connectGitWorkspace(url, head.branch, home)
          : await createGitWorkspace(
              url,
              basename(url).replace(/\.git$/, "") || "Workspace",
              home,
            )),
    };

    write(`${dim("Git repo")}  ${url}`);
    write(
      dim(
        "Anything merged to its default branch installs on every machine that selected it, including code that runs. Keeping the repo safe is the job of its maintainers and members, so protect the default branch.",
      ),
    );

    if (!head && !cloned) {
      write(
        dim(
          "Next, protect the default branch on your Git host and let members push other branches.",
        ),
      );
    }
  }

  if (server) {
    write(`${dim("Workspace")}  ${server}`);
    let session;
    try {
      session = await authStatus(home, server);
    } catch (error) {
      if (!(error instanceof LoginRequiredError)) {
        throw error;
      }

      await runLogin(
        { server, browser: options.browser !== false, home, force: true },
        write,
      );

      session = await authStatus(home, server);
    }

    write(
      `${dim("Signed in")}  ${session.context.developer.name} · ${session.context.organization.name}`,
    );
  }

  const keptFolder =
    previous && choice.kind !== "local" ? previous.localWorkspace : undefined;

  const localCount = keptFolder
    ? await localRepoSource(keptFolder, home)
        .model()
        .then((model) => model.assets.length + model.knowledge.length)
        .catch(() => 0)
    : 0;

  const localChoice: LocalAssetChoice = localCount
    ? await (options.chooseLocalAssets ?? chooseLocalAssets)(localCount)
    : "keep";

  const connected = Boolean(server || workspace);
  write("");
  let environmentChoices: EnvironmentChoices | undefined;
  const initialized = initialize({
    home,
    server,
    workspace,
    keepLocal: localChoice === "leave" ? undefined : keptFolder,
    cwd: options.cwd,
    chooseEnvironment: async (choices) => {
      environmentChoices = choices;

      return (options.chooseEnvironment ?? environmentChooser(write))(choices);
    },
    choose: options.choose ?? chooseHarnesses,
    detected: options.detected,
    confirm: async (settings) => {
      write("");
      write(bold("Review setup") + dim(" (applies to this whole machine)"));
      write("");
      for (const line of fields([
        ["Coding tools", settings.harnesses.join(", ") || "none"],
        [
          "Workspace",
          settings.connection?.server ??
            settings.gitWorkspace?.url ??
            settings.localWorkspace?.path,
        ],
      ])) {
        write(line);
      }

      if (settings.connection || settings.gitWorkspace) {
        const selection = selectionState(settings);
        write("");
        write(
          `${bold("Scope sets")} ${dim(`(${selection.subscriptions.length})`)}`,
        );

        write(
          selection.subscriptions.length
            ? table(
                selection.subscriptions.map((subscription) => {
                  const scope = environmentChoices?.scopes.find(
                    (scope) =>
                      scope.id === subscription.scope.id &&
                      scope.type === subscription.scope.type,
                  );

                  if (!scope && settings.localWorkspace) {
                    return ["local", "Your local assets", subscription.mode];
                  }

                  return [
                    scope
                      ? originLabel(scope)
                      : `${subscription.scope.type}/${subscription.scope.id}`,
                    scope?.name ?? "",
                    subscription.mode,
                  ];
                }),
                { header: ["Scope", "Name", "Mode"] },
              ).join("\n")
            : dim("  None."),
        );

        // Git setups rarely pick single assets, so only show a section with something in it.
        if (!settings.gitWorkspace || selection.individualAssetIds.length) {
          write("");
          write(
            `${bold("Individual assets")} ${dim(`(${selection.individualAssetIds.length})`)}`,
          );

          write(
            selection.individualAssetIds.length
              ? table(
                  selection.individualAssetIds.map((id) => {
                    const asset = environmentChoices?.catalog.assets.find(
                      (asset) => asset.id === id,
                    );

                    return asset
                      ? [asset.name, asset.kind, originLabel(asset.origin)]
                      : [id, "", ""];
                  }),
                  { header: ["Name", "Kind", "Origin"] },
                ).join("\n")
              : dim("  None."),
          );
        }
      }

      write("");

      return options.confirmApply
        ? options.confirmApply(settings)
        : confirm({
            message: connected
              ? "Save and install this environment?"
              : "Save this local setup?",
            default: true,
            theme: promptTheme,
          });
    },
    apply: connected
      ? async (settings) => {
          for (const line of renderSyncOutput(
            await synchronize(undefined, home, settings),
          )) {
            write(line);
          }
        }
      : undefined,
  });

  const result = await initialized
    .catch((error: unknown) => {
      discardWorkspace?.();
      throw error;
    })
    .finally(keepWorkspace);

  if (result.cancelled) {
    discardWorkspace?.();
    write(
      "Setup cancelled. Configuration and installed assets were not changed. Your sign-in is retained.",
    );

    return;
  }

  if (localChoice === "move" && localCount) {
    const to =
      choice.kind === "cloud"
        ? await (options.chooseMoveTarget ?? chooseMoveTarget)(
            await cloudMoveTargets(home),
          )
        : undefined;

    write("");
    for (const line of renderMove(await moveLocalAssets({ to }, home))) {
      write(line);
    }
  }

  write("");
  write(`${selected("✔")} Saved to ${result.configPath}`);
  write("");
  if (connected) {
    write(
      `${dim("Next:")} ${bold("barndog status")}  ${dim("see what's installed and where")}`,
    );

    write(
      choice.kind === "cloud"
        ? `      ${bold("barndog skills install")}  ${dim("add more (also mcp, hooks, sets)")}`
        : `      ${bold("barndog skills add <url>")}  ${dim("add from a repo (also hooks add, mcp add)")}`,
    );

    write(`      ${bold("barndog sync")}  ${dim("pick up published updates")}`);
    if (choice.kind === "local") {
      write(
        `      ${dim(`add assets under ${workspace?.kind === "local" ? workspace.local.path : ""}`)}`,
      );
    }
  } else {
    write(
      `${dim("Next:")} ${bold("barndog sync")}  ${dim("then connect a Git repo or Cloud Workspace later with barndog init")}`,
    );
  }
}
