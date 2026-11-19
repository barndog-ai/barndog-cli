import { resolve } from "node:path";
import type { RuntimeContext } from "./runtime.js";
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
import { registerHarnesses } from "./commands/harnesses.js";
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
import {
  changeHarnesses,
  listHarnesses,
  selectHarnesses,
} from "./features/environment/harnesses.js";
import { doctor } from "./features/doctor/index.js";
import { repoStatus, workspaceUrl } from "./features/inspection/index.js";
import { validateFolder } from "./features/workspace/assets.js";
import { migrate } from "./features/migration/migrate.js";
import { listLocalAssets, moveLocalAssets } from "./features/migration/move.js";
import { adoptNative } from "./features/adoption/adopt.js";
import { undoAdoption } from "./features/adoption/undo.js";
import { listAdoptions } from "./features/adoption/record.js";
import { scanNative } from "./features/adoption/scan.js";
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
import { registerAdopt } from "./commands/adopt.js";
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
import { showPackage } from "./features/inventory/show.js";
import {
  forgetMcpValue,
  keepMcpValue,
  listKeptValues,
} from "./features/mcps/values.js";
import { readSettings } from "./config/settings.js";

/** Keep command help readable at the conventional eighty-column terminal width. */
const HELP_WIDTH = 80;

export type ProgramOptions = Partial<Omit<CommandContext, "mode" | "home">> & {
  writeError?: (message: string) => void;
  /** Tests pin terminal detection; the CLI detects a TTY. */
  interactive?: boolean;
  /** Tests pass a temporary directory; the CLI uses the real home directory. */
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Stops commands the current setup can't run. The CLI always passes one. */
  guard?: (path: string[], options: Record<string, unknown>) => Promise<void>;
  /** Dims commands this setup can't run in help. */
  setupMode?: SetupMode;
};

/** Help sections, in order; every top-level command belongs to one. */
const groups: [string, string[]][] = [
  [
    "Get started:",
    [
      "init",
      "login",
      "logout",
      "auth",
      "whoami",
      "sync",
      "status",
      "doctor",
      "harnesses",
      "adopt",
    ],
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

/** Process entry points capture ambient inputs here; downstream code receives this object. */
export function captureRuntime(
  options: Partial<RuntimeContext> = {},
): RuntimeContext {
  const cwd = resolve(options.cwd ?? process.cwd());

  return {
    home: resolve(cwd, options.home ?? homedir()),
    cwd,
    env: { ...(options.env ?? process.env) },
    platform: options.platform ?? process.platform,
  };
}

/** Construct a fresh parser for every invocation or test; command behavior is independently injectable. */
export function createProgram(options: ProgramOptions = {}): Command {
  const write = options.write ?? console.log;
  // The one place the real home directory is read; everything below takes it.
  const runtime = options.runtime ?? captureRuntime(options);
  const { home } = runtime;
  const mode: Mode = {
    json: false,
    interactive: options.interactive ?? interactiveTerminal(),
  };

  const context: CommandContext = {
    applySuggestion:
      options.applySuggestion ?? ((target) => applySuggestion(target, runtime)),
    changeDiff: options.changeDiff ?? ((target) => changeDiff(target, runtime)),
    commentOnChange:
      options.commentOnChange ??
      ((options) => commentOnChange(options, runtime)),
    createPackage:
      options.createPackage ?? ((target) => createPackage(target, runtime)),
    diffVersions:
      options.diffVersions ?? ((target) => diffVersions(target, runtime)),
    listChanges:
      options.listChanges ?? ((options) => listChanges(options, runtime)),
    mergeChange:
      options.mergeChange ?? ((target) => mergeChange(target, runtime)),
    packageVersions:
      options.packageVersions ?? ((target) => packageVersions(target, runtime)),
    pullPackage:
      options.pullPackage ?? ((target) => pullPackage(target, runtime)),
    pushWorkingCopy:
      options.pushWorkingCopy ??
      ((options) => pushWorkingCopy(options, runtime)),
    rejectChange:
      options.rejectChange ?? ((target) => rejectChange(target, runtime)),
    resolveFile: options.resolveFile ?? ((path) => resolveFile(path, runtime)),
    reviewChange:
      options.reviewChange ??
      ((decision, target) => reviewChange(decision, target, runtime)),
    setDiscussionResolved:
      options.setDiscussionResolved ??
      ((target) => setDiscussionResolved(target, runtime)),
    showChange: options.showChange ?? ((target) => showChange(target, runtime)),
    updateWorkingCopy:
      options.updateWorkingCopy ?? (() => updateWorkingCopy(runtime)),
    versionFiles:
      options.versionFiles ?? ((target) => versionFiles(target, runtime)),
    workingDiff: options.workingDiff ?? (() => workingDiff(runtime)),
    workingStatus: options.workingStatus ?? (() => workingStatus(runtime)),
    login:
      options.login ??
      ((login) =>
        runLogin({ ...login, runtime, interactive: mode.interactive }, write)),
    logout: options.logout ?? (() => runLogout(write, runtime)),
    authStatus:
      options.authStatus ??
      (() => showAuthStatus({ write, json: mode.json }, runtime)),
    isSetUp:
      options.isSetUp ??
      // A damaged file counts as set up: the command that reads it explains what's wrong.
      (async () => (await readSettings(home).catch(() => true)) !== null),
    setup:
      options.setup ??
      ((restart, server, setupOptions) =>
        runSetup({
          restart,
          server,
          ...setupOptions,
          interactive: mode.interactive,
          write: options.write,
          runtime,
        })),
    changeAsset:
      options.changeAsset ??
      ((change, target) => changeAsset(change, target, runtime)),
    changeAssets:
      options.changeAssets ??
      ((change, target) => changeAssets(change, target, runtime)),
    renameAsset:
      options.renameAsset ?? ((target) => renameAsset(target, runtime)),
    listSets: options.listSets ?? (() => listSets(runtime)),
    previewSet: options.previewSet ?? ((origin) => previewSet(origin, runtime)),
    installSet:
      options.installSet ?? ((options) => installSet(options, runtime)),
    installSetAssets:
      options.installSetAssets ??
      ((options) => installSetAssets(options, runtime)),
    changeSet:
      options.changeSet ??
      ((change, options) => changeSet(change, options, runtime)),
    switchSet: options.switchSet ?? ((options) => switchSet(options, runtime)),
    setKnowledge:
      options.setKnowledge ?? ((enabled) => setKnowledge(enabled, runtime)),
    listHarnesses: options.listHarnesses ?? (() => listHarnesses(runtime)),
    changeHarnesses:
      options.changeHarnesses ??
      ((change, targets) => changeHarnesses(change, targets, runtime)),
    selectHarnesses:
      options.selectHarnesses ??
      ((selected) => selectHarnesses(selected, runtime)),
    doctor: options.doctor ?? (() => doctor(runtime)),
    workspaceUrl: options.workspaceUrl ?? (() => workspaceUrl(runtime)),
    repoStatus: options.repoStatus ?? (() => repoStatus(runtime)),
    scanNative: options.scanNative ?? (() => scanNative(runtime)),
    adoptNative:
      options.adoptNative ?? ((keys, keep) => adoptNative(keys, keep, runtime)),
    listAdoptions: options.listAdoptions ?? (() => listAdoptions(home)),
    undoAdoption:
      options.undoAdoption ?? ((target) => undoAdoption(target, runtime)),
    listLocalAssets:
      options.listLocalAssets ?? (() => listLocalAssets(runtime)),
    knowledgeProblems:
      options.knowledgeProblems ?? (() => knowledgeProblems(runtime)),
    githubStatus: options.githubStatus ?? (() => githubStatus(runtime)),
    githubInstallations:
      options.githubInstallations ?? (() => githubInstallations(runtime)),
    githubList: options.githubList ?? (() => githubList(runtime)),
    validateFolder:
      options.validateFolder ??
      ((directory) => validateFolder(directory, runtime)),
    migrate: options.migrate ?? ((options) => migrate(options, runtime)),
    moveLocalAssets:
      options.moveLocalAssets ??
      ((options) => moveLocalAssets(options, runtime)),
    updateImported:
      options.updateImported ??
      ((kind, name, options) => updateImported(kind, name, options, runtime)),
    keepMcpValue:
      options.keepMcpValue ??
      ((variable, value) => keepMcpValue(variable, value, runtime)),
    forgetMcpValue:
      options.forgetMcpValue ??
      ((variable) => forgetMcpValue(variable, runtime)),
    listKeptValues: options.listKeptValues ?? (() => listKeptValues(runtime)),
    showPackage:
      options.showPackage ??
      ((kind, name, origin) => showPackage(kind, name, origin, runtime)),
    showMcp:
      options.showMcp ?? ((name, origin) => showMcp(name, origin, runtime)),
    createMcp: options.createMcp ?? ((input) => createMcp(input, runtime)),
    updateMcp: options.updateMcp ?? ((input) => updateMcp(input, runtime)),
    mcpVersions:
      options.mcpVersions ??
      ((name, origin) => mcpVersions(name, origin, runtime)),
    authenticateMcp:
      options.authenticateMcp ??
      ((name, origin, harness) =>
        authenticateMcp(name, origin, harness, runtime)),
    testHook:
      options.testHook ??
      ((name, origin, testOptions) =>
        testHook(name, origin, testOptions, runtime)),
    hookCompatibility:
      options.hookCompatibility ??
      ((name, origin) => hookCompatibility(name, origin, runtime)),
    adaptHook:
      options.adaptHook ??
      ((name, origin, targets) => adaptHook(name, origin, targets, runtime)),
    knowledgeGet:
      options.knowledgeGet ?? ((name) => knowledgeGet(name, runtime)),
    developers: options.developers ?? ((search) => developers(search, runtime)),
    developerAssets:
      options.developerAssets ??
      ((selector, search) => developerAssets(selector, search, runtime)),
    promote: options.promote ?? ((input) => promote(input, runtime)),
    fork: options.fork ?? ((input) => fork(input, runtime)),
    githubAuth: options.githubAuth ?? (() => githubAuth(runtime)),
    githubInstall: options.githubInstall ?? (() => githubInstall(runtime)),
    githubConnect:
      options.githubConnect ?? ((options) => githubConnect(options, runtime)),
    githubImport:
      options.githubImport ?? ((options) => githubImport(options, runtime)),
    githubImportCopy:
      options.githubImportCopy ??
      ((options) => githubImportCopy(options, runtime)),
    githubCreateRepository:
      options.githubCreateRepository ??
      ((options) => githubCreateRepository(options, runtime)),
    githubShow:
      options.githubShow ??
      ((connectionId) => githubShow(connectionId, runtime)),
    githubSync:
      options.githubSync ??
      ((connectionId) => githubSync(connectionId, runtime)),
    githubRemoteHead:
      options.githubRemoteHead ??
      ((connectionId) => githubRemoteHead(connectionId, runtime)),
    githubResolveMirror:
      options.githubResolveMirror ??
      ((options) => githubResolveMirror(options, runtime)),
    githubPullsList:
      options.githubPullsList ??
      ((connectionId) => githubPullsList(connectionId, runtime)),
    githubPullsShow:
      options.githubPullsShow ??
      ((connectionId, number) =>
        githubPullsShow(connectionId, number, runtime)),
    githubPullsCreate:
      options.githubPullsCreate ??
      ((options) => githubPullsCreate(options, runtime)),
    githubPullsRevise:
      options.githubPullsRevise ??
      ((options) => githubPullsRevise(options, runtime)),
    githubPullsReview:
      options.githubPullsReview ??
      ((options) => githubPullsReview(options, runtime)),
    githubPullsComment:
      options.githubPullsComment ??
      ((options) => githubPullsComment(options, runtime)),
    githubPullsMerge:
      options.githubPullsMerge ??
      ((options) => githubPullsMerge(options, runtime)),
    knowledgeList:
      options.knowledgeList ?? ((always) => knowledgeList(always, runtime)),
    synchronize:
      options.synchronize ??
      ((path, syncOptions) =>
        synchronize(path, runtime, undefined, syncOptions)),
    inventory: options.inventory ?? (() => inventory(runtime)),
    searchCatalog:
      options.searchCatalog ?? ((kind) => searchCatalog(kind, runtime)),
    write,
    mode,
    runtime,
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
    .version(
      versionReport(runtime.platform),
      "-V, --version",
      "Show the version and build",
    )
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
    .action(async (_, command: Command) => {
      if (command.args.length) {
        program.error(`error: unknown command '${command.args[0]}'`);
      }

      // Setup needs a terminal; without one, help says to run `barndog init`.
      if (mode.interactive && !(await context.isSetUp())) {
        return context.setup(true);
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
      !runtime.env.CI;

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
  registerHarnesses(program, context);
  registerAdopt(program, context);
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
