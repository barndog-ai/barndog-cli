/**
 * What working-copy and review operations return. Git and Cloud backends
 * return the same types, so commands render either without asking which.
 */
import type { Change, GitConnection } from "@barndog-ai/api-contract";
import type { FileDiff } from "@barndog-ai/api-contract/collaboration";
import type { PackageKind } from "../../config/selection.js";
import type { GitPull } from "../github/pulls.js";
import type { Files } from "./workspace-store.js";

/** A new working folder for an asset that isn't published yet. */
export type CreatedPackage = { root: string; kind: PackageKind; name: string };

/** A working folder pulled at a Git commit, or at a Cloud version number. */
export type PulledPackage =
  { root: string; commit: string } | { root: string; version: number };

/** A Git working copy after `pull` merged the newest commit into it. */
export type UpdatedGitWorkingCopy = {
  root: string;
  conflicts: string[];
  baseVersion: null;
  commit: string;
};

/** A Cloud working copy after `pull` merged the newest version into it. */
export type UpdatedCloudWorkingCopy = {
  root: string;
  conflicts: string[];
  baseVersion: number | null;
  /** Set when GitHub is authoritative and its pull request was reconciled too. */
  external?: { connectionId: string; pull: number | undefined };
};

export type UpdatedWorkingCopy =
  UpdatedGitWorkingCopy | UpdatedCloudWorkingCopy;

/**
 * A Git working copy and its edits. Git has no version numbers or proposals, so
 * those fields are always null.
 */
export type GitWorkingCopyStatus = {
  root: string;
  name: string;
  baseVersion: null;
  baseCommit: string;
  proposal: null;
  /** The review branch and its pull request, once pushed. */
  review: { branch: string; url: string | null } | null;
  conflicts: string[];
  pending: boolean;
  external: null;
  changes: FileDiff[];
};

/**
 * A Cloud working copy, the version and proposal it is linked to, and its
 * edits.
 */
export type CloudWorkingCopyStatus = {
  root: string;
  name: string;
  baseVersion: number | null;
  proposal: { id: string; revision: number } | null;
  conflicts: string[];
  /** An upload that failed ambiguously and is kept for an exact retry. */
  pending: boolean;
  external: {
    connectionId: string;
    pull: { number: number; head: string } | null;
  } | null;
  changes: FileDiff[];
};

export type WorkingCopyStatus = GitWorkingCopyStatus | CloudWorkingCopyStatus;

/** What `push` did in a Git workspace: nothing, a direct publish, or a review branch. */
export type GitPushResult =
  | { unchanged: true }
  | { branch: string; commit: string; published: true }
  | { branch: string; commit: string; url: string | null; opened: boolean };

/**
 * What `push` did in Cloud: the proposal, or for a GitHub-authoritative asset
 * its pull request (or connection, once merged); `unchanged` when there was
 * nothing new to send.
 */
export type CloudPushResult =
  | Change
  | GitPull
  | GitConnection
  | { unchanged: true; pull: number | undefined }
  | { unchanged: true; proposalId: string | undefined };

export type PushResult = GitPushResult | CloudPushResult;

/**
 * The file just marked resolved and the conflicts still left, as paths inside
 * the working copy.
 */
export type ConflictResolution = { resolved: string; remaining: string[] };

/** One published version. Cloud also names who published it, when the server says. */
export type PackageVersion = {
  number: number;
  commit: string;
  publishedAt: string;
  publishedBy: string;
  description: string;
  publisherName?: string;
};

/** A version's files, base64-encoded. */
export type VersionFiles = { files: Files };

/** A proposal with its files and the names of the people in it. */
export type ChangeDetails = Change & {
  /** Developer ID → display name, for authors and reviewers. */
  names: Record<string, string>;
  baseVersionNumber: number | undefined;
  files: Files;
};
