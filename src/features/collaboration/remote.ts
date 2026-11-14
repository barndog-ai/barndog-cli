import { homedir } from "node:os";
import {
  changeSchema,
  type Change,
  type Skill,
} from "@barndog-ai/api-contract";
import { publishedSkills } from "../skills/catalog.js";
import { publishedHooks } from "../hooks/catalog.js";
import { type Hook, assetNotFound } from "../asset-kinds/index.js";
import { unpackDownload } from "../workspace/packages.js";
import { collaborationClient } from "./domain.js";
import { type PackageKind } from "../../config/selection.js";
import { type Connection } from "../../config/settings.js";
import { only } from "../../shared/lookup.js";
import { matchesOrigin } from "../server/origin.js";

/**
 * The one published Skill or Hook named `name` in the origin `selector`; throws
 * the usual not-found error when none or several match.
 */
export async function selectSkill(
  {
    name,
    selector,
    kind = "skill",
  }: { name: string; selector: string; kind?: PackageKind },
  conn: Connection,
  home = homedir(),
) {
  const values = await packageCatalogs[kind](conn, home);
  const matches = values.filter(
    (s) => s.name === name && matchesOrigin(s.origin, selector, conn),
  );

  const match = only(matches);
  if (!match) {
    throw assetNotFound(kind, name, selector);
  }

  return match;
}

type DownloadOptions = { home?: string; kind?: PackageKind };

/** The package of one published version, checked against that version's commit. */
export function downloadVersion(
  version: { id: string; number: number; commit: string },
  conn: Connection,
  { home = homedir(), kind = "skill" }: DownloadOptions = {},
) {
  return unpackDownload(
    collaborationClient(conn.server, home, kind).GET(
      "/v1/skills/{id}/versions/{version}/package",
      {
        params: { path: { id: version.id, version: version.number } },
        parseAs: "stream",
      },
    ),
    { kind, commit: version.commit, subject: "the package" },
  );
}

/** The package of a Suggested Change at one revision, checked against its commit. */
export function downloadChange(
  change: { id: string; revision: number; commit: string },
  conn: Connection,
  { home = homedir(), kind = "skill" }: DownloadOptions = {},
) {
  return unpackDownload(
    collaborationClient(conn.server, home, kind).GET(
      "/v1/skill-changes/{id}/package",
      {
        params: {
          path: { id: change.id },
          query: { revision: change.revision },
        },
        parseAs: "stream",
      },
    ),
    { kind, commit: change.commit, subject: "the package" },
  );
}

/** The package at the head of a GitHub pull request, checked against that head. */
export function downloadPull(
  pull: { connectionId: string; number: number; head: string },
  conn: Connection,
  { home = homedir(), kind = "skill" }: DownloadOptions = {},
) {
  return unpackDownload(
    collaborationClient(conn.server, home, kind).GET(
      "/v1/git-connections/{id}/pulls/{number}/package",
      {
        params: { path: { id: pull.connectionId, number: pull.number } },
        parseAs: "stream",
      },
    ),
    { kind, commit: pull.head, subject: "the package" },
  );
}

export async function getChange(
  id: string,
  conn: Connection,
  home = homedir(),
  kind: PackageKind = "skill",
): Promise<Change> {
  return changeSchema.parse(
    (
      await collaborationClient(conn.server, home, kind).GET(
        "/v1/skill-changes/{id}",
        {
          params: { path: { id } },
        },
      )
    ).data,
  );
}

/** Every published package of a kind that you can see. */
const packageCatalogs: Record<
  PackageKind,
  (conn: Connection, home: string) => Promise<(Skill | Hook)[]>
> = { skill: publishedSkills, hook: publishedHooks };
