import { Command, Help, Option } from "commander";
import { homedir } from "node:os";
import { styleText } from "node:util";
import {
  registerCollaboration,
  registerWorkingCopy,
} from "./commands/collaboration.js";
import {
  applySuggestion,
  changeDiff,
  commentOnChange,
  createPackage,
  diffVersions,
  listChanges,
  mergeChange,
  packageVersions,
  pullPackage,
  pushWorkingCopy,
  rejectChange,
  resolveFile,
  reviewChange,
  setDiscussionResolved,
  showChange,
  updateWorkingCopy,
  versionFiles,
  workingDiff,
  workingStatus,
} from "./features/collaboration/index.js";
import { registerAuth } from "./commands/auth.js";
import { runLogin, runLogout, showAuthStatus } from "./ui/auth.js";
import { registerInit } from "./commands/init.js";
import { registerSync } from "./commands/sync.js";
import { registerStatus } from "./commands/status.js";
import type { CommandContext, Mode } from "./commands/context.js";
import { clashPrompt, synchronize } from "./features/environment/sync.js";
import {
  changeAsset,
  changeAssets,
  changeSet,
  installSet,
  installSetAssets,
  listSets,
  previewSet,
  renameAsset,
  setKnowledge,
  switchSet,
} from "./features/environment/operations.js";
import { doctor } from "./features/doctor/index.js";
import { repoStatus, workspaceUrl } from "./features/inspection/index.js";
import { validateFolder } from "./features/workspace/assets.js";
import { migrate } from "./features/migration/migrate.js";
import { listLocalAssets, moveLocalAssets } from "./features/migration/move.js";
import { updateImported } from "./features/imports/local.js";
import {
  authenticateMcp,
  createMcp,
  mcpVersions,
  showMcp,
  updateMcp,
} from "./features/mcps/index.js";
import { adaptHook, toolNames } from "./features/hooks/adapt.js";
import { harnesses } from "./harnesses/registry.js";
import { hookCompatibility } from "./features/hooks/compatibility.js";
import { testHook } from "./features/hooks/test.js";
import {
  knowledgeGet,
  knowledgeList,
  knowledgeProblems,
} from "./features/knowledge/index.js";
import {
  developerAssets,
  developers,
  fork,
} from "./features/discovery/index.js";
import { promote } from "./features/migration/promote.js";
import {
  githubAuth,
  githubInstall,
  githubInstallations,
  githubStatus,
} from "./features/github/account.js";
import {
  githubConnect,
  githubCreateRepository,
  githubImport,
  githubImportCopy,
  githubList,
  githubRemoteHead,
  githubResolveMirror,
  githubShow,
  githubSync,
} from "./features/github/connections.js";
import {
  githubPullsComment,
  githubPullsCreate,
  githubPullsList,
  githubPullsMerge,
  githubPullsReview,
  githubPullsRevise,
  githubPullsShow,
} from "./features/github/pulls.js";
import { inventory } from "./features/inventory/index.js";
import { searchCatalog } from "./features/catalog/index.js";
import { registerEnvironment } from "./commands/environment.js";
import { registerCapabilities } from "./commands/capabilities.js";
import { registerWorkspace } from "./commands/workspace.js";
import { registerAdd } from "./commands/add.js";
import {
  commandNeeds,
  modeName,
  needText,
  unavailableNote,
  type CommandNeed,
  type SetupMode,
} from "./commands/availability.js";
import { runSetup } from "./ui/onboarding.js";
import { interactiveTerminal } from "./ui/pick.js";
import { promptClash } from "./ui/clash.js";
import { primary } from "./ui/theme.js";
import { versionReport } from "./version.js";
import { defined } from "./shared/lookup.js";
import { barndogPaths } from "./config/paths.js";

/** Keep command help readable at the conventional eighty-column terminal width. */
const HELP_WIDTH = 80;

export type ProgramOptions = Partial<Omit<CommandContext, "mode" | "home">> & {
  writeError?: (message: string) => void;
  /** Tests pin terminal detection; the CLI detects a TTY. */
  interactive?: boolean;
  /** Tests pass a temporary directory; the CLI uses the real home directory. */
  home?: string;
  /** Stops commands the current setup can't run. The CLI always passes one. */
  guard?: (path: string[], options: Record<string, unknown>) => Promise<void>;
  /** Dims commands this setup can't run in help. */
  setupMode?: SetupMode;
};

/** Help sections, in order; every top-level command belongs to one. */
const groups: [string, string[]][] = [
  [
    "Get started:",
    ["init", "login", "logout", "auth", "whoami", "sync", "status", "doctor"],
  ],
  ["Assets:", ["skills", "mcp", "hooks", "sets", "knowledge"]],
  [
    "Working copy & review (run inside a folder from `skills pull`, `hooks pull` or `create`):",
    ["pull", "diff", "push", "resolve"],
  ],
  [
    "Workspace:",
    ["people", "repo", "github", "open", "local", "validate", "migrate"],
  ],
];

/** Sections inside `skills`, `mcp` and `hooks` help. */
const assetGroups: [string, string[]][] = [
  [
    "On this machine:",
    [
      "list",
      "search",
      "add",
      "install",
      "remove",
      "enable",
      "disable",
      "rename",
    ],
  ],
  ["Share:", ["fork", "promote"]],
  [
    "Edit and review:",
    ["pull", "create", "push", "versions", "show", "diff", "changes"],
  ],
  ["Publish directly:", ["update", "auth"]],
  ["Test and adapt:", ["test", "compatibility", "adapt"]],
];

/** The command's words without the program name, as availability rules name them. */
/** The help section of a command in an asset group. */
function helpGroup(group: string, command: string, heading: string) {
  // MCP create/show/versions publish or inspect definitions directly.
  if (group === "mcp" && ["create", "show", "versions"].includes(command)) {
    return "Publish directly:";
  }

  if (group !== "mcp" && command === "update") {
    return "On this machine:";
  }

  return heading;
}

function commandPath(command: Command) {
  const path: string[] = [];
  for (let c: Command | null = command; c?.parent; c = c.parent) {
    path.unshift(c.name());
  }

  return path.join(" ");
}

/** A group is unavailable only when nothing inside it can run. */
function helpNeed(command: Command, mode: SetupMode): CommandNeed | undefined {
  const children = command.commands.filter((c) => c.name() !== "help");
  if (!children.length) {
    return commandNeeds(commandPath(command), mode);
  }

  const needs = children.map((child) => helpNeed(child, mode));
  if (!needs.every(Boolean)) {
    return undefined;
  }

  return needs.includes("shared") ? "shared" : "cloud";
}

function listsUnavailable(command: Command) {
  let root = command;
  while (root.parent) {
    root = root.parent;
  }

  return root.opts().listUnavailable === true;
}

/** Hides what this setup can't run, unless asked for or already looking at one. */
function limitedHelp(mode: SetupMode): Partial<Help> {
  const dimmed = new Set<string>();
  const note = (command: Command) => {
    const need = listsUnavailable(command) && helpNeed(command, mode);

    return need ? unavailableNote(need, mode) : undefined;
  };

  return {
    visibleCommands(this: Help, command: Command) {
      const commands = Help.prototype.visibleCommands.call(this, command);

      return listsUnavailable(command) || helpNeed(command, mode)
        ? commands
        : commands.filter((child) => !helpNeed(child, mode));
    },
    subcommandTerm(this: Help, command: Command) {
      const term = Help.prototype.subcommandTerm.call(this, command);
      if (note(command)) {
        dimmed.add(term);
      }

      return term;
    },
    subcommandDescription(this: Help, command: Command) {
      const description = Help.prototype.subcommandDescription.call(
        this,
        command,
      );

      const text = note(command);

      return text ? `${description} (${text})` : description;
    },
    styleSubcommandTerm(this: Help, term: string) {
      return dimmed.has(term)
        ? styleText("dim", term)
        : Help.prototype.styleSubcommandTerm.call(this, term);
    },
  };
}

/** The closing lines of help: what was left out, why, and how to see it. */
function unavailableHint(command: Command, mode: SetupMode) {
  const own = helpNeed(command, mode);
  if (own) {
    return `\n${styleText("dim", unavailableNote(own, mode))}`;
  }

  if (listsUnavailable(command)) {
    return "";
  }

  const hidden = new Help().visibleCommands(command).flatMap((child) => {
    const need = helpNeed(child, mode);

    return need ? [{ name: child.name(), need }] : [];
  });

  if (!hidden.length) {
    return "";
  }

  const need = hidden.some((c) => c.need === "shared") ? "shared" : "cloud";
  const one = hidden.length === 1;
  const path = commandPath(command);
  const help = new Help();
  const width = Math.min(process.stdout.columns || HELP_WIDTH, HELP_WIDTH);
  const lines = [
    `${one ? "One command is" : "Some commands are"} hidden in ${modeName(mode)} mode because ${one ? "it needs" : "they need"} ${needText(need)}: ${hidden.map((c) => c.name).join(", ")}.`,
    `Run barndog ${path ? `${path} ` : ""}--help --list-unavailable to see ${one ? "it" : "them"}.`,
  ];

  return `\n${styleText("dim", lines.map((line) => help.boxWrap(line, width)).join("\n"))}`;
}

type Guard = NonNullable<ProgramOptions["guard"]>;

/**
 * Commander checks required options before `preAction`, so say a command can't run
 * here before complaining about its flags. Help stays available either way.
 */
function guardRequiredOptions(parent: Command, guard: Guard) {
  for (const child of parent.commands) {
    guardRequiredOptions(child, guard);
  }

  if (!parent.commands.length) {
    return;
  }

  parent.hook("preSubcommand", async (_, command) => {
    if (command.commands.length || !command.options.some((o) => o.mandatory)) {
      return;
    }

    let root: Command = parent;
    while (root.parent) {
      root = root.parent;
    }

    const { rawArgs = [] } = root as Command & { rawArgs?: string[] };
    if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
      return;
    }

    await guard(commandPath(command).split(" "), {});
  });
}

/** Construct a fresh parser for every invocation or test; command behavior is independently injectable. */
export function createProgram(options: ProgramOptions = {}): Command {
  const write = options.write ?? console.log;
  // The one place the real home directory is read; everything below takes it.
  const home = options.home ?? homedir();
  const mode: Mode = {
    json: false,
    interactive: options.interactive ?? interactiveTerminal(),
  };

  const context: CommandContext = {
    applySuggestion:
      options.applySuggestion ?? ((target) => applySuggestion(target, home)),
    changeDiff: options.changeDiff ?? ((target) => changeDiff(target, home)),
    commentOnChange:
      options.commentOnChange ?? ((options) => commentOnChange(options, home)),
    createPackage:
      options.createPackage ??
      ((target) => createPackage(target, undefined, home)),
    diffVersions:
      options.diffVersions ?? ((target) => diffVersions(target, home)),
    listChanges:
      options.listChanges ?? ((options) => listChanges(options, home)),
    mergeChange: options.mergeChange ?? ((target) => mergeChange(target, home)),
    packageVersions:
      options.packageVersions ?? ((target) => packageVersions(target, home)),
    pullPackage:
      options.pullPackage ?? ((target) => pullPackage(target, undefined, home)),
    pushWorkingCopy:
      options.pushWorkingCopy ??
      ((options) => pushWorkingCopy(options, undefined, home)),
    rejectChange:
      options.rejectChange ?? ((target) => rejectChange(target, home)),
    resolveFile:
      options.resolveFile ?? ((path) => resolveFile(path, undefined, home)),
    reviewChange:
      options.reviewChange ??
      ((decision, target) => reviewChange(decision, target, home)),
    setDiscussionResolved:
      options.setDiscussionResolved ??
      ((target) => setDiscussionResolved(target, home)),
    showChange: options.showChange ?? ((target) => showChange(target, home)),
    updateWorkingCopy:
      options.updateWorkingCopy ?? (() => updateWorkingCopy(undefined, home)),
    versionFiles:
      options.versionFiles ?? ((target) => versionFiles(target, home)),
    workingDiff: options.workingDiff ?? (() => workingDiff(undefined, home)),
    workingStatus:
      options.workingStatus ?? (() => workingStatus(undefined, home)),
    login: options.login ?? ((login) => runLogin({ ...login, home }, write)),
    logout: options.logout ?? (() => runLogout(write, home)),
    authStatus:
      options.authStatus ??
      (() => showAuthStatus({ write, json: mode.json }, home)),
    setup:
      options.setup ??
      ((restart, server, setupOptions) =>
        runSetup({
          restart,
          server,
          ...setupOptions,
          write: options.write,
          home,
        })),
    changeAsset:
      options.changeAsset ??
      ((change, target) => changeAsset(change, target, home)),
    changeAssets:
      options.changeAssets ??
      ((change, target) => changeAssets(change, target, home)),
    renameAsset: options.renameAsset ?? ((target) => renameAsset(target, home)),
    listSets: options.listSets ?? (() => listSets(home)),
    previewSet: options.previewSet ?? ((origin) => previewSet(origin, home)),
    installSet: options.installSet ?? ((options) => installSet(options, home)),
    installSetAssets:
      options.installSetAssets ??
      ((options) => installSetAssets(options, home)),
    changeSet:
      options.changeSet ??
      ((change, options) => changeSet(change, options, home)),
    switchSet: options.switchSet ?? ((options) => switchSet(options, home)),
    setKnowledge:
      options.setKnowledge ?? ((enabled) => setKnowledge(enabled, home)),
    doctor: options.doctor ?? (() => doctor(home)),
    workspaceUrl: options.workspaceUrl ?? (() => workspaceUrl(home)),
    repoStatus: options.repoStatus ?? (() => repoStatus(home)),
    listLocalAssets: options.listLocalAssets ?? (() => listLocalAssets(home)),
    knowledgeProblems:
      options.knowledgeProblems ?? (() => knowledgeProblems(home)),
    githubStatus: options.githubStatus ?? (() => githubStatus(home)),
    githubInstallations:
      options.githubInstallations ?? (() => githubInstallations(home)),
    githubList: options.githubList ?? (() => githubList(home)),
    validateFolder: options.validateFolder ?? validateFolder,
    migrate: options.migrate ?? ((options) => migrate(options, home)),
    moveLocalAssets:
      options.moveLocalAssets ?? ((options) => moveLocalAssets(options, home)),
    updateImported:
      options.updateImported ??
      ((kind, name, options) => updateImported(kind, name, options, home)),
    showMcp: options.showMcp ?? ((name, origin) => showMcp(name, origin, home)),
    createMcp: options.createMcp ?? ((input) => createMcp(input, home)),
    updateMcp: options.updateMcp ?? ((input) => updateMcp(input, home)),
    mcpVersions:
      options.mcpVersions ??
      ((name, origin) => mcpVersions(name, origin, home)),
    authenticateMcp:
      options.authenticateMcp ??
      ((name, origin, harness) => authenticateMcp(name, origin, harness, home)),
    testHook:
      options.testHook ??
      ((name, origin, testOptions) =>
        testHook(name, origin, testOptions, { home })),
    hookCompatibility:
      options.hookCompatibility ??
      ((name, origin) => hookCompatibility(name, origin, home)),
    adaptHook:
      options.adaptHook ??
      ((name, origin, targets) => adaptHook(name, origin, targets, home)),
    knowledgeGet: options.knowledgeGet ?? ((name) => knowledgeGet(name, home)),
    developers: options.developers ?? ((search) => developers(search, home)),
    developerAssets:
      options.developerAssets ??
      ((selector, search) => developerAssets(selector, search, home)),
    promote: options.promote ?? ((input) => promote(input, home)),
    fork: options.fork ?? ((input) => fork(input, home)),
    githubAuth: options.githubAuth ?? (() => githubAuth(home)),
    githubInstall: options.githubInstall ?? (() => githubInstall(home)),
    githubConnect:
      options.githubConnect ?? ((options) => githubConnect(options, home)),
    githubImport:
      options.githubImport ?? ((options) => githubImport(options, home)),
    githubImportCopy:
      options.githubImportCopy ??
      ((options) => githubImportCopy(options, home)),
    githubCreateRepository:
      options.githubCreateRepository ??
      ((options) => githubCreateRepository(options, home)),
    githubShow:
      options.githubShow ?? ((connectionId) => githubShow(connectionId, home)),
    githubSync:
      options.githubSync ?? ((connectionId) => githubSync(connectionId, home)),
    githubRemoteHead:
      options.githubRemoteHead ??
      ((connectionId) => githubRemoteHead(connectionId, home)),
    githubResolveMirror:
      options.githubResolveMirror ??
      ((options) => githubResolveMirror(options, home)),
    githubPullsList:
      options.githubPullsList ??
      ((connectionId) => githubPullsList(connectionId, home)),
    githubPullsShow:
      options.githubPullsShow ??
      ((connectionId, number) => githubPullsShow(connectionId, number, home)),
    githubPullsCreate:
      options.githubPullsCreate ??
      ((options) => githubPullsCreate(options, home)),
    githubPullsRevise:
      options.githubPullsRevise ??
      ((options) => githubPullsRevise(options, home)),
    githubPullsReview:
      options.githubPullsReview ??
      ((options) => githubPullsReview(options, home)),
    githubPullsComment:
      options.githubPullsComment ??
      ((options) => githubPullsComment(options, home)),
    githubPullsMerge:
      options.githubPullsMerge ??
      ((options) => githubPullsMerge(options, home)),
    knowledgeList:
      options.knowledgeList ?? ((always) => knowledgeList(always, home)),
    synchronize:
      options.synchronize ??
      ((path, syncOptions) => synchronize(path, home, undefined, syncOptions)),
    inventory: options.inventory ?? (() => inventory(home)),
    searchCatalog:
      options.searchCatalog ?? ((kind) => searchCatalog(kind, home)),
    write,
    mode,
    home,
  };

  const program = new Command()
    .name("barndog")
    .description(
      `${primary(styleText("bold", "BarnDog"))} keeps your team's Skills, MCP servers and Hooks in sync across ${toolNames(harnesses)}.`,
    )
    .exitOverride()
    .configureOutput({
      writeOut: (text) => context.write(text.trimEnd()),
      writeErr: (text) => (options.writeError ?? console.error)(text.trimEnd()),
    })
    .configureHelp({
      styleTitle: (text) => styleText("bold", text),
      styleCommandText: (text) => styleText("bold", text),
      styleSubcommandText: (text) => styleText("bold", text),
      styleOptionText: (text) => styleText("bold", text),
      styleArgumentText: (text) => styleText("cyan", text),
      styleDescriptionText: (text) => text,
      styleSubcommandDescription: (text) => styleText("dim", text),
      styleOptionDescription: (text) => styleText("dim", text),
      ...(options.setupMode ? limitedHelp(options.setupMode) : {}),
    })
    .version(versionReport(), "-V, --version", "Show the version and build")
    .option("--json", "Print machine-readable JSON")
    .option("--no-interactive", "Never prompt; fail with a hint instead")
    .addOption(
      new Option(
        "--list-unavailable",
        "With --help, include commands this setup can't run",
      ).hideHelp(!options.setupMode),
    )
    .showHelpAfterError(
      styleText("dim", "Add --help to any command to see its usage."),
    )
    .addHelpText(
      "after",
      `\nRun ${styleText("bold", "barndog <command> --help")} for details. Configuration: ${barndogPaths(home).settings}`,
    )
    .addHelpText("afterAll", ({ command }) =>
      options.setupMode ? unavailableHint(command, options.setupMode) : "",
    )
    .action((_, command: Command) => {
      if (command.args.length) {
        program.error(`error: unknown command '${command.args[0]}'`);
      }

      program.help();
    });

  program.hook("preAction", async (_, action) => {
    const flags = action.optsWithGlobals<{
      json?: boolean;
      interactive?: boolean;
    }>();

    mode.json = !!flags.json;
    mode.interactive =
      mode.interactive &&
      flags.interactive !== false &&
      !mode.json &&
      !process.env.CI;

    if (!options.synchronize && mode.interactive) {
      clashPrompt.resolver = promptClash;
    } else if (!mode.interactive) {
      clashPrompt.resolver = undefined;
    }

    const path: string[] = [];
    for (let c: Command | null = action; c?.parent; c = c.parent) {
      path.unshift(c.name());
    }

    await options.guard?.(path, action.opts());
  });

  registerAuth(program, context);
  registerInit(program, context);
  registerSync(program, context);
  registerStatus(program, context);
  registerEnvironment(program, context);
  registerCapabilities(program, context);
  registerWorkspace(program, context);
  registerWorkingCopy(program, context);
  registerCollaboration(program, context, "skill");
  registerCollaboration(program, context, "hook");
  registerAdd(program, context);
  const order = groups.flatMap(([, names]) => names);
  for (const [heading, names] of groups) {
    for (const name of names) {
      program.commands.find((c) => c.name() === name)?.helpGroup(heading);
    }
  }

  // Commander lists groups in command order, so sort commands into section order.
  // Commander types `commands` as readonly but offers no other way to reorder them.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  (program.commands as Command[]).sort(
    (a, b) => order.indexOf(a.name()) - order.indexOf(b.name()),
  );

  program.commandsGroup("Get started:").helpCommand(true);
  for (const name of ["skills", "mcp", "hooks"]) {
    const group = defined(
      program.commands.find((c) => c.name() === name),
      `Command group ${name} isn't registered`,
    );

    for (const [heading, names] of assetGroups) {
      for (const command of group.commands) {
        if (names.includes(command.name())) {
          command.helpGroup(helpGroup(name, command.name(), heading));
        }
      }
    }
  }

  if (options.guard) {
    guardRequiredOptions(program, options.guard);
  }

  // Only the root accepts stray words, to report them as unknown commands.
  program.allowExcessArguments(true);

  return program;
}
