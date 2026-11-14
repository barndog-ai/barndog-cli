import { homedir } from "node:os";
import {
  changeSchema,
  type Change,
  type Skill,
} from "@barndog-ai/api-contract";
import { parsePackage, defaultLimits } from "@barndog-ai/api-contract/package";
import { publishedSkills } from "../skills/catalog.js";
import { publishedHooks } from "../hooks/catalog.js";
import { type Hook, assetKinds, assetNotFound } from "../asset-kinds/index.js";
import { serverFetch } from "../auth/transport.js";
import { collaborationClient, packagePath } from "./domain.js";
import { type PackageKind } from "../../config/selection.js";
import { type Connection } from "../../config/settings.js";
import { CliError, PackageError } from "../../errors.js";
import { only } from "../../shared/lookup.js";
import { matchesOrigin } from "../server/origin.js";

/** CLI policy: bound review writes to thirty seconds. */
const REVIEW_REQUEST_TIMEOUT_MS = 30000;

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

/**
 * Downloads and unpacks a package from the server, within the package size
 * limits and a 30-second timeout. With `commit`, refuses a package whose ETag
 * names another revision.
 */
export async function download(
  path: string,
  conn: Connection,
  {
    home = homedir(),
    commit,
    kind = "skill",
  }: { home?: string; commit?: string; kind?: PackageKind } = {},
) {
  const response = await serverFetch(conn.server, home)(
    `${conn.server}${packagePath(path, kind)}`,
    { signal: AbortSignal.timeout(REVIEW_REQUEST_TIMEOUT_MS) },
  );

  if (!response.ok) {
    throw new CliError(
      `Downloading the package failed (${response.status}). Try again.`,
    );
  }

  if (commit && response.headers.get("etag") !== `"${commit}"`) {
    throw new CliError(
      "The package changed on the server while it was downloading. Try again.",
    );
  }

  if (!response.body) {
    throw new Error("The server sent a package download with no body");
  }

  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > defaultLimits.compressed) {
      throw new PackageError("PACKAGE_TOO_LARGE");
    }

    chunks.push(chunk);
  }

  return parsePackage(
    Buffer.concat(chunks),
    defaultLimits,
    assetKinds[kind].manifest,
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
