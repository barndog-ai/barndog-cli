import type { Change, GitConnection } from "@barndog-ai/api-contract";
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
import type { Inventory } from "../features/inventory/index.js";
import type { CatalogAsset } from "../features/catalog/index.js";
import type {
  McpServer,
  PublishedAsset,
} from "../features/asset-kinds/index.js";
import type { AssetKind } from "../features/asset-selection/types.js";
import type { Harness } from "../harnesses/types.js";
import type { Check } from "../features/doctor/index.js";
import type { RepositoryStatus } from "../features/inspection/index.js";
import type {
  FolderSummary,
  RepoAssetView,
} from "../features/git-workspace/assets.js";
import type {
  MigrateOptions,
  MigrationReport,
} from "../features/git-workspace/migrate.js";
import type {
  LocalAssets,
  MoveOptions,
  MoveResult,
} from "../features/git-workspace/move.js";
import type { ImportUpdate } from "../features/imports/local.js";
import type {
  McpAuthentication,
  McpUpdateInput,
  McpVersion,
  McpWriteInput,
} from "../features/mcps/index.js";
import type { Adaptation } from "../features/hooks/adapt.js";
import type { HookCompatibility } from "../features/hooks/compatibility.js";
import type {
  HookTestOptions,
  HookTestResult,
} from "../features/hooks/test.js";
import type {
  KnowledgeDocument,
  KnowledgeListing,
} from "../features/knowledge/index.js";
import type { InvalidKnowledge } from "../features/git-workspace/format.js";
import type {
  Developer,
  DeveloperAssets,
  Promotion,
  PromoteInput,
  PromoteResult,
} from "../features/discovery/index.js";
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

  doctor: () => Promise<Check[]>;
  workspaceUrl: () => Promise<string>;
  repoStatus: () => Promise<RepositoryStatus>;
  validateFolder: (directory: string) => Promise<FolderSummary>;
  migrate: (options: MigrateOptions) => Promise<MigrationReport>;

  listLocalAssets: () => Promise<LocalAssets>;
  moveLocalAssets: (options: MoveOptions) => Promise<MoveResult>;
  updateImported: (
    kind: "skill" | "hook",
    name: string | undefined,
    options: { force?: boolean; dryRun?: boolean },
  ) => Promise<ImportUpdate[]>;

  showMcp: (
    name: string,
    origin: string,
  ) => Promise<RepoAssetView | PublishedAsset>;
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
    targets?: readonly Harness[],
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
  listChanges: (options: ChangeListOptions) => Promise<Change[]>;
  showChange: (target: ChangeTarget) => Promise<ChangeDetails>;
  changeDiff: (target: ChangeDiffTarget) => Promise<FileDiff[]>;
  reviewChange: (
    decision: ReviewDecision,
    target: ChangeRevision,
  ) => Promise<Change>;
  rejectChange: (target: ChangeRevision) => Promise<Change>;
  mergeChange: (target: ChangeRevision) => Promise<Change>;
  commentOnChange: (options: CommentOptions) => Promise<Change>;
  applySuggestion: (target: ThreadRevision) => Promise<Change>;
  setDiscussionResolved: (target: ThreadResolution) => Promise<Change>;

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
