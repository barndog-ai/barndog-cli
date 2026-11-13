import type {
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
} from "../features/collaboration/index.js";
import type { SyncEvent } from "../features/environment/events.js";
import type { SyncOptions } from "../features/environment/sync.js";
import type {
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
} from "../features/environment/operations.js";
import type { Inventory } from "../features/inventory/index.js";
import type { CatalogAsset } from "../features/catalog/index.js";
import type { AssetKind } from "../features/asset-selection/types.js";
import type { Harness } from "../harnesses/types.js";
import type { doctor } from "../features/doctor/index.js";
import type { repoStatus, workspaceUrl } from "../features/inspection/index.js";
import type { validateFolder } from "../features/git-workspace/assets.js";
import type { migrate } from "../features/git-workspace/migrate.js";
import type {
  listLocalAssets,
  moveLocalAssets,
} from "../features/git-workspace/move.js";
import type { updateImported } from "../features/imports/local.js";
import type {
  authenticateMcp,
  createMcp,
  mcpVersions,
  showMcp,
  updateMcp,
} from "../features/mcps/index.js";
import type { adaptHook } from "../features/hooks/adapt.js";
import type { hookCompatibility } from "../features/hooks/compatibility.js";
import type { testHook } from "../features/hooks/test.js";
import type {
  knowledgeGet,
  knowledgeList,
  knowledgeProblems,
} from "../features/knowledge/index.js";
import type {
  developerAssets,
  developers,
  fork,
  promote,
  PromoteInput,
} from "../features/discovery/index.js";
import type {
  githubAuth,
  githubInstall,
  githubInstallations,
  githubStatus,
} from "../features/github/account.js";
import type {
  githubConnect,
  githubCreateRepository,
  githubImport,
  githubImportCopy,
  githubList,
  githubRemoteHead,
  githubResolveMirror,
  githubShow,
  githubSync,
} from "../features/github/connections.js";
import type {
  githubPullsComment,
  githubPullsCreate,
  githubPullsList,
  githubPullsMerge,
  githubPullsReview,
  githubPullsRevise,
  githubPullsShow,
} from "../features/github/pulls.js";

/** The first argument of a feature function: its options. */
type Options<F extends (...args: never[]) => unknown> = Parameters<F>[0];

/** Output and prompting preferences resolved from global flags and the terminal. */
export type Mode = { json: boolean; interactive: boolean };

export type CommandContext = {
  login: (options: {
    server?: string;
    browser: boolean;
    force?: boolean;
  }) => Promise<void>;
  logout: () => Promise<void>;
  authStatus: () => Promise<void>;
  setup: (
    restart: boolean,
    server?: string,
    options?: { local?: boolean; repo?: string; browser?: boolean },
  ) => Promise<void>;
  synchronize: (
    configPath?: string,
    options?: Pick<SyncOptions, "dryRun" | "refresh" | "prompt">,
  ) => Promise<SyncEvent[]>;
  inventory: () => Promise<Inventory>;
  searchCatalog: (kind: AssetKind) => Promise<CatalogAsset[]>;
  write: (message: string) => void;
  mode: Mode;
} & FeatureFunctions;

/**
 * The feature functions commands call, as commands see them: each has the
 * signature of the function it is named after, without the `home` argument.
 */
type FeatureFunctions = {
  changeAsset: (
    change: Parameters<typeof changeAsset>[0],
    target: Parameters<typeof changeAsset>[1],
  ) => ReturnType<typeof changeAsset>;
  changeAssets: (
    change: Parameters<typeof changeAssets>[0],
    target: Parameters<typeof changeAssets>[1],
  ) => ReturnType<typeof changeAssets>;
  renameAsset: (
    target: Options<typeof renameAsset>,
  ) => ReturnType<typeof renameAsset>;
  listSets: () => ReturnType<typeof listSets>;
  previewSet: (origin: string) => ReturnType<typeof previewSet>;
  installSet: (
    options: Options<typeof installSet>,
  ) => ReturnType<typeof installSet>;
  installSetAssets: (
    options: Options<typeof installSetAssets>,
  ) => ReturnType<typeof installSetAssets>;
  changeSet: (
    change: Parameters<typeof changeSet>[0],
    options: Parameters<typeof changeSet>[1],
  ) => ReturnType<typeof changeSet>;
  switchSet: (
    options: Options<typeof switchSet>,
  ) => ReturnType<typeof switchSet>;
  setKnowledge: (enabled: boolean) => ReturnType<typeof setKnowledge>;

  doctor: () => ReturnType<typeof doctor>;
  workspaceUrl: () => ReturnType<typeof workspaceUrl>;
  repoStatus: () => ReturnType<typeof repoStatus>;
  validateFolder: (directory: string) => ReturnType<typeof validateFolder>;
  migrate: (options: Options<typeof migrate>) => ReturnType<typeof migrate>;

  listLocalAssets: () => ReturnType<typeof listLocalAssets>;
  moveLocalAssets: (
    options: Options<typeof moveLocalAssets>,
  ) => ReturnType<typeof moveLocalAssets>;
  updateImported: (
    kind: "skill" | "hook",
    name: string | undefined,
    options: { force?: boolean; dryRun?: boolean },
  ) => ReturnType<typeof updateImported>;

  showMcp: (name: string, origin: string) => ReturnType<typeof showMcp>;
  createMcp: (input: Options<typeof createMcp>) => ReturnType<typeof createMcp>;
  updateMcp: (input: Options<typeof updateMcp>) => ReturnType<typeof updateMcp>;
  mcpVersions: (name: string, origin: string) => ReturnType<typeof mcpVersions>;
  authenticateMcp: (
    name: string,
    origin: string,
    harness: Harness,
  ) => ReturnType<typeof authenticateMcp>;

  testHook: (
    name: string,
    origin: string,
    options: Parameters<typeof testHook>[2],
  ) => ReturnType<typeof testHook>;
  hookCompatibility: (
    name: string,
    origin: string,
  ) => ReturnType<typeof hookCompatibility>;
  adaptHook: (
    name: string,
    origin: string,
    targets?: readonly Harness[],
  ) => ReturnType<typeof adaptHook>;

  knowledgeList: (always?: boolean) => ReturnType<typeof knowledgeList>;
  knowledgeProblems: () => ReturnType<typeof knowledgeProblems>;
  knowledgeGet: (name: string) => ReturnType<typeof knowledgeGet>;

  developers: (search?: string) => ReturnType<typeof developers>;
  developerAssets: (
    handle: string,
    search?: string,
  ) => ReturnType<typeof developerAssets>;
  promote: (input: PromoteInput) => ReturnType<typeof promote>;
  fork: (input: PromoteInput) => ReturnType<typeof fork>;

  createPackage: (
    target: Options<typeof createPackage>,
  ) => ReturnType<typeof createPackage>;
  pullPackage: (
    target: Options<typeof pullPackage>,
  ) => ReturnType<typeof pullPackage>;
  updateWorkingCopy: () => ReturnType<typeof updateWorkingCopy>;
  workingStatus: () => ReturnType<typeof workingStatus>;
  workingDiff: () => ReturnType<typeof workingDiff>;
  pushWorkingCopy: (
    options: Options<typeof pushWorkingCopy>,
  ) => ReturnType<typeof pushWorkingCopy>;
  resolveFile: (path: string) => ReturnType<typeof resolveFile>;
  packageVersions: (
    target: Options<typeof packageVersions>,
  ) => ReturnType<typeof packageVersions>;
  versionFiles: (
    target: Options<typeof versionFiles>,
  ) => ReturnType<typeof versionFiles>;
  diffVersions: (
    target: Options<typeof diffVersions>,
  ) => ReturnType<typeof diffVersions>;
  listChanges: (
    options: Options<typeof listChanges>,
  ) => ReturnType<typeof listChanges>;
  showChange: (
    target: Options<typeof showChange>,
  ) => ReturnType<typeof showChange>;
  changeDiff: (
    target: Options<typeof changeDiff>,
  ) => ReturnType<typeof changeDiff>;
  reviewChange: (
    decision: Parameters<typeof reviewChange>[0],
    target: Parameters<typeof reviewChange>[1],
  ) => ReturnType<typeof reviewChange>;
  rejectChange: (
    target: Options<typeof rejectChange>,
  ) => ReturnType<typeof rejectChange>;
  mergeChange: (
    target: Options<typeof mergeChange>,
  ) => ReturnType<typeof mergeChange>;
  commentOnChange: (
    options: Options<typeof commentOnChange>,
  ) => ReturnType<typeof commentOnChange>;
  applySuggestion: (
    target: Options<typeof applySuggestion>,
  ) => ReturnType<typeof applySuggestion>;
  setDiscussionResolved: (
    target: Options<typeof setDiscussionResolved>,
  ) => ReturnType<typeof setDiscussionResolved>;

  githubStatus: () => ReturnType<typeof githubStatus>;
  githubAuth: (
    options: Options<typeof githubAuth>,
  ) => ReturnType<typeof githubAuth>;
  githubInstall: (
    options: Options<typeof githubInstall>,
  ) => ReturnType<typeof githubInstall>;
  githubInstallations: () => ReturnType<typeof githubInstallations>;

  githubList: () => ReturnType<typeof githubList>;
  githubConnect: (
    options: Options<typeof githubConnect>,
  ) => ReturnType<typeof githubConnect>;
  githubImport: (
    options: Options<typeof githubImport>,
  ) => ReturnType<typeof githubImport>;
  githubImportCopy: (
    options: Options<typeof githubImportCopy>,
  ) => ReturnType<typeof githubImportCopy>;
  githubCreateRepository: (
    options: Options<typeof githubCreateRepository>,
  ) => ReturnType<typeof githubCreateRepository>;
  githubShow: (connectionId: string) => ReturnType<typeof githubShow>;
  githubSync: (connectionId: string) => ReturnType<typeof githubSync>;
  githubRemoteHead: (
    connectionId: string,
  ) => ReturnType<typeof githubRemoteHead>;
  githubResolveMirror: (
    options: Options<typeof githubResolveMirror>,
  ) => ReturnType<typeof githubResolveMirror>;

  githubPullsList: (connectionId: string) => ReturnType<typeof githubPullsList>;
  githubPullsShow: (
    connectionId: string,
    number: number,
  ) => ReturnType<typeof githubPullsShow>;
  githubPullsCreate: (
    options: Options<typeof githubPullsCreate>,
  ) => ReturnType<typeof githubPullsCreate>;
  githubPullsRevise: (
    options: Options<typeof githubPullsRevise>,
  ) => ReturnType<typeof githubPullsRevise>;
  githubPullsReview: (
    options: Options<typeof githubPullsReview>,
  ) => ReturnType<typeof githubPullsReview>;
  githubPullsComment: (
    options: Options<typeof githubPullsComment>,
  ) => ReturnType<typeof githubPullsComment>;
  githubPullsMerge: (
    options: Options<typeof githubPullsMerge>,
  ) => ReturnType<typeof githubPullsMerge>;
};
