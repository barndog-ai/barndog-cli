import type { RuntimeContext } from "../runtime.js";
import type { GitConnection } from "@barndog-ai/api-contract";
import type { FileDiff } from "@barndog-ai/api-contract/collaboration";
import type {
  ChangeDiffTarget,
  ChangeListOptions,
  ChangeRevision,
  ChangeTarget,
  CommentOptions,
  EnvironmentPreview,
  EnvironmentStatus,
  PackageTarget,
  PushOptions,
  ReviewDecision,
  ThreadResolution,
  ThreadRevision,
  VersionRange,
  VersionTarget,
  WorkingCopyTarget,
} from "../features/collaboration/index.js";
import type {
  ChangeDetails,
  ConflictResolution,
  CreatedPackage,
  PackageVersion,
  PulledPackage,
  PushResult,
  UpdatedWorkingCopy,
  VersionFiles,
  WorkingCopyStatus,
} from "../features/collaboration/results.js";
import type { SyncEvent } from "../features/environment/events.js";
import type { SyncOptions } from "../features/environment/sync.js";
import type {
  Applied,
  AssetChange,
  AssetIds,
  AssetRename,
  AssetTarget,
  Overrides,
  SelectionOutcome,
  SetAssets,
  SetChange,
  SetPreview,
  SetSelection,
  SetsList,
  SetTarget,
} from "../features/environment/operations.js";
import type {
  HarnessChange,
  HarnessesApplied,
  HarnessStatus,
} from "../features/environment/harnesses.js";
import type {
  Inventory,
  InventoryOptions,
} from "../features/inventory/index.js";
import type { CatalogAsset, McpServer } from "../features/asset-kinds/index.js";
import type { AssetKind, PackageKind } from "../config/selection.js";
import type { Harness, HookHarness } from "../harnesses/types.js";
import type { Check } from "../features/doctor/index.js";
import type {
  UninstallOptions,
  UninstallResult,
} from "../features/uninstall/index.js";
import type { UninstallSurvey } from "../features/uninstall/survey.js";
import type { RepositoryStatus } from "../features/inspection/index.js";
import type { FolderSummary } from "../features/workspace/assets.js";
import type {
  MigrateOptions,
  MigrationReport,
} from "../features/migration/migrate.js";
import type { PackageDetails } from "../features/inventory/show.js";
import type { KeptValueChange, KeptVariable } from "../features/mcps/values.js";
import type {
  LocalAssets,
  MoveOptions,
  MoveResult,
} from "../features/migration/move.js";
import type { ImportUpdate } from "../features/imports/local.js";
import type { AdoptionResult } from "../features/adoption/adopt.js";
import type { AdoptionSummary } from "../features/adoption/record.js";
import type { UndoResult, UndoTarget } from "../features/adoption/undo.js";
import type { NativeScan } from "../features/adoption/scan.js";
import type {
  McpAuthentication,
  McpUpdateInput,
  McpVersion,
  McpWriteInput,
  ShownMcp,
} from "../features/mcps/index.js";
import type { Adaptation } from "../features/hooks/adapt.js";
import type { HookCompatibility } from "../features/hooks/types.js";
import type {
  HookTestOptions,
  HookTestResult,
} from "../features/hooks/test.js";
import type {
  KnowledgeDocument,
  KnowledgeListing,
} from "../features/knowledge/index.js";
import type { InvalidKnowledge } from "../features/workspace/format.js";
import type {
  Developer,
  DeveloperAssets,
  Promotion,
  PromoteInput,
} from "../features/discovery/index.js";
import type { PromoteResult } from "../features/migration/promote.js";
import type {
  GithubInstallation,
  GithubPage,
  GithubStatus,
} from "../features/github/account.js";
import type {
  GitCopyImportResult,
  GithubConnectOptions,
  GithubCreateRepositoryOptions,
  GithubImportCopyOptions,
  GithubRepositoryOptions,
  GithubResolveMirrorOptions,
  GitRemoteHead,
  MirrorResolved,
} from "../features/github/connections.js";
import type {
  GithubPullsCommentOptions,
  GithubPullsCreateOptions,
  GithubPullsMergeOptions,
  GithubPullsReviewOptions,
  GithubPullsReviseOptions,
  GitPull,
  GitPullDetails,
} from "../features/github/pulls.js";
import type { PackageChange } from "../features/collaboration/results.js";

/** Output and prompting preferences resolved from global flags and the terminal. */
export type Mode = { json: boolean; interactive: boolean };

/**
 * Services and ambient inputs injected into command handlers, allowing tests to
 * replace individual operations.
 */
export type CommandContext = {
  login: (options: {
    server?: string;
    browser: boolean;
    force?: boolean;
  }) => Promise<void>;
  logout: () => Promise<void>;
  authStatus: () => Promise<void>;
  /** Whether `~/.barndog/config.yaml` exists, so bare `barndog` can start setup instead of help. */
  isSetUp: () => Promise<boolean>;
  setup: (
    restart: boolean,
    server?: string,
    options?: { local?: boolean; repo?: string; browser?: boolean },
  ) => Promise<void>;
  synchronize: (
    configPath?: string,
    options?: Pick<SyncOptions, "dryRun" | "refresh" | "prompt">,
  ) => Promise<SyncEvent[]>;
  inventory: (options?: InventoryOptions) => Promise<Inventory>;
  searchCatalog: (kind: AssetKind) => Promise<CatalogAsset[]>;
  write: (message: string) => void;
  mode: Mode;
  /** The home directory every command works in; resolved once in `createProgram()`. */
  runtime: RuntimeContext;
} & FeatureFunctions;

/**
 * The feature functions commands call, as commands see them: each has the
 * signature of the function it is named after, without the `home` argument.
 */
type FeatureFunctions = {
  changeAsset: (
    change: AssetChange,
    target: AssetTarget & Overrides,
  ) => Promise<SelectionOutcome>;
  changeAssets: (
    change: AssetChange,
    target: AssetIds & Overrides,
  ) => Promise<SelectionOutcome>;
  renameAsset: (target: AssetRename) => Promise<Applied>;
  listSets: () => Promise<SetsList>;
  previewSet: (origin: string) => Promise<SetPreview>;
  installSet: (options: SetSelection) => Promise<SelectionOutcome>;
  installSetAssets: (options: SetAssets) => Promise<Applied>;
  changeSet: (
    change: SetChange,
    options: SetTarget,
  ) => Promise<SelectionOutcome>;
  switchSet: (options: SetSelection) => Promise<SelectionOutcome>;
  setKnowledge: (enabled: boolean) => Promise<Applied>;
  listHarnesses: () => Promise<HarnessStatus[]>;
  changeHarnesses: (
    change: HarnessChange,
    harnesses: readonly Harness[],
  ) => Promise<HarnessesApplied>;
  selectHarnesses: (harnesses: readonly Harness[]) => Promise<HarnessesApplied>;

  doctor: () => Promise<Check[]>;
  workspaceUrl: () => Promise<string>;
  repoStatus: () => Promise<RepositoryStatus>;
  validateFolder: (directory: string) => Promise<FolderSummary>;
  migrate: (options: MigrateOptions) => Promise<MigrationReport>;

  scanNative: () => Promise<NativeScan>;
  adoptNative: (
    keys: readonly string[],
    keep: readonly string[],
  ) => Promise<AdoptionResult>;
  listAdoptions: () => Promise<AdoptionSummary[]>;
  undoAdoption: (target: UndoTarget) => Promise<UndoResult>;

  uninstallSurvey: () => Promise<UninstallSurvey>;
  uninstall: (options: UninstallOptions) => Promise<UninstallResult>;

  listLocalAssets: () => Promise<LocalAssets>;
  moveLocalAssets: (options: MoveOptions) => Promise<MoveResult>;
  updateImported: (
    kind: "skill" | "hook",
    name: string | undefined,
    options: { force?: boolean; dryRun?: boolean },
  ) => Promise<ImportUpdate[]>;

  keepMcpValue: (variable: string, value: string) => Promise<KeptValueChange>;
  forgetMcpValue: (variable: string) => Promise<KeptValueChange>;
  listKeptValues: () => Promise<KeptVariable[]>;
  showPackage: (
    kind: PackageKind,
    name: string,
    origin: string,
  ) => Promise<PackageDetails>;
  showMcp: (name: string, origin: string) => Promise<ShownMcp>;
  createMcp: (input: McpWriteInput) => Promise<McpServer>;
  updateMcp: (input: McpUpdateInput) => Promise<McpServer>;
  mcpVersions: (
    name: string,
    origin: string,
  ) => Promise<PackageVersion[] | McpVersion[]>;
  authenticateMcp: (
    name: string,
    origin: string,
    harness: Harness,
  ) => Promise<McpAuthentication>;

  testHook: (
    name: string,
    origin: string,
    options: HookTestOptions,
  ) => Promise<HookTestResult>;
  hookCompatibility: (
    name: string,
    origin: string,
  ) => Promise<HookCompatibility>;
  adaptHook: (
    name: string,
    origin: string,
    targets?: readonly HookHarness[],
  ) => Promise<Adaptation>;

  knowledgeList: (always?: boolean) => Promise<KnowledgeListing[]>;
  knowledgeProblems: () => Promise<InvalidKnowledge[]>;
  knowledgeGet: (name: string) => Promise<KnowledgeDocument>;

  developers: (search?: string) => Promise<Developer[]>;
  developerAssets: (
    handle: string,
    search?: string,
  ) => Promise<DeveloperAssets>;
  promote: (input: PromoteInput) => Promise<PromoteResult>;
  fork: (input: PromoteInput) => Promise<Promotion>;

  createPackage: (target: WorkingCopyTarget) => Promise<CreatedPackage>;
  pullPackage: (target: WorkingCopyTarget) => Promise<PulledPackage>;
  updateWorkingCopy: () => Promise<UpdatedWorkingCopy>;
  workingStatus: () => Promise<WorkingCopyStatus | EnvironmentStatus>;
  workingDiff: () => Promise<FileDiff[] | EnvironmentPreview>;
  pushWorkingCopy: (options: PushOptions) => Promise<PushResult>;
  resolveFile: (path: string) => Promise<ConflictResolution>;
  packageVersions: (target: PackageTarget) => Promise<PackageVersion[]>;
  versionFiles: (target: VersionTarget) => Promise<VersionFiles>;
  diffVersions: (target: VersionRange) => Promise<FileDiff[]>;
  listChanges: (options: ChangeListOptions) => Promise<PackageChange[]>;
  showChange: (target: ChangeTarget) => Promise<ChangeDetails>;
  changeDiff: (target: ChangeDiffTarget) => Promise<FileDiff[]>;
  reviewChange: (
    decision: ReviewDecision,
    target: ChangeRevision,
  ) => Promise<PackageChange>;
  rejectChange: (target: ChangeRevision) => Promise<PackageChange>;
  mergeChange: (target: ChangeRevision) => Promise<PackageChange>;
  commentOnChange: (options: CommentOptions) => Promise<PackageChange>;
  applySuggestion: (target: ThreadRevision) => Promise<PackageChange>;
  setDiscussionResolved: (target: ThreadResolution) => Promise<PackageChange>;

  githubStatus: () => Promise<GithubStatus>;
  githubAuth: () => Promise<GithubPage>;
  githubInstall: () => Promise<GithubPage>;
  githubInstallations: () => Promise<GithubInstallation[]>;

  githubList: () => Promise<GitConnection[]>;
  githubConnect: (options: GithubConnectOptions) => Promise<GitConnection>;
  githubImport: (options: GithubRepositoryOptions) => Promise<GitConnection>;
  githubImportCopy: (
    options: GithubImportCopyOptions,
  ) => Promise<GitCopyImportResult>;
  githubCreateRepository: (
    options: GithubCreateRepositoryOptions,
  ) => Promise<GitConnection>;
  githubShow: (connectionId: string) => Promise<GitConnection>;
  githubSync: (connectionId: string) => Promise<GitConnection>;
  githubRemoteHead: (connectionId: string) => Promise<GitRemoteHead>;
  githubResolveMirror: (
    options: GithubResolveMirrorOptions,
  ) => Promise<MirrorResolved>;

  githubPullsList: (connectionId: string) => Promise<GitPull[]>;
  githubPullsShow: (
    connectionId: string,
    number: number,
  ) => Promise<GitPullDetails>;
  githubPullsCreate: (options: GithubPullsCreateOptions) => Promise<GitPull>;
  githubPullsRevise: (options: GithubPullsReviseOptions) => Promise<GitPull>;
  githubPullsReview: (
    options: GithubPullsReviewOptions,
  ) => Promise<GitPullDetails>;
  githubPullsComment: (
    options: GithubPullsCommentOptions,
  ) => Promise<GitPullDetails>;
  githubPullsMerge: (
    options: GithubPullsMergeOptions,
  ) => Promise<GitConnection>;
};
