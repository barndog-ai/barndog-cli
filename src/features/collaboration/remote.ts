import { homedir } from "node:os";
import { z } from "zod";
import {
  changeSchema,
  contextSchema,
  memberSchema,
  scopeSchema,
  type Change,
  type Skill,
} from "@barndog-ai/api-contract";
import { parsePackage, defaultLimits } from "@barndog-ai/api-contract/package";
import { apiClient, catalog } from "../skills/remote.js";
import { publishedHooks, type Hook } from "../hooks/catalog.js";
import { serverFetch } from "../auth/transport.js";
import { collaborationClient, packagePath } from "./domain.js";
import {
  assetKinds,
  assetNotFound,
  type PackageKind,
} from "../asset-kinds/index.js";
import { readSettings, type Connection } from "../../config/settings.js";
import { CliError } from "../../errors.js";
import { only } from "../../shared/lookup.js";
import { splitOrigin } from "../../shared/patterns.js";

export async function connection(home = homedir(), expected?: Connection) {
  const settings = await readSettings(home);
  if (
    settings &&
    !settings.connection &&
    (settings.gitWorkspace || settings.localWorkspace)
  )
    throw new CliError(
      `This needs a BarnDog Cloud Workspace. This machine keeps its assets in ${settings.gitWorkspace ? "a Git repo" : "a local folder"}.`,
      settings.gitWorkspace
        ? "barndog migrate --to <server>"
        : "barndog init --server <url>",
    );
  if (!settings || !settings.connection)
    throw new CliError(
      "This machine isn't connected to a BarnDog workspace.",
      "barndog init",
    );
  const saved = settings.connection;
  if (
    expected &&
    (expected.server !== saved.server ||
      expected.organizationId !== saved.organizationId ||
      expected.developerId !== saved.developerId)
  )
    throw new Error(
      "Working copy belongs to another server, organization, or developer",
    );
  const actor = contextSchema.parse(
    (await apiClient(saved.server, home).GET("/v1/context")).data,
  );
  if (
    actor.organization.id !== saved.organizationId ||
    actor.developer.id !== saved.developerId
  )
    throw new Error(
      "Authenticated identity does not match the saved connection",
    );
  return saved;
}

export function matchesOrigin(
  origin: { type: string; id: string; slug?: string; localOnly?: boolean },
  selector: string,
  conn: Pick<Connection, "organizationId"> & { developerId?: string },
) {
  if (selector === "local") return origin.localOnly === true;
  if (selector === "org")
    return origin.type === "org" && origin.id === conn.organizationId;
  if (selector === "me")
    return origin.type === "dev" && origin.id === conn.developerId;
  const { type, value = "" } = splitOrigin(selector);
  return origin.type === type && [origin.id, origin.slug].includes(value);
}

export async function selectSkill(
  name: string,
  selector: string,
  conn: Connection,
  home = homedir(),
  kind: PackageKind = "skill",
) {
  const values = await packageCatalogs[kind](conn, home);
  const matches = values.filter(
    (s) => s.name === name && matchesOrigin(s.origin, selector, conn),
  );
  const match = only(matches);
  if (!match) throw assetNotFound(kind, name, selector);
  return match;
}

export async function selectOrigin(
  selector: string,
  conn: Connection,
  home = homedir(),
) {
  const scopes = z
    .array(scopeSchema)
    .parse((await apiClient(conn.server, home).GET("/v1/scopes")).data);
  const matches = scopes.filter((s) => matchesOrigin(s, selector, conn));
  const personal = splitOrigin(selector);
  if (
    !matches.length &&
    personal.type === "dev" &&
    personal.value !== undefined
  ) {
    const actor = contextSchema.parse(
      (await apiClient(conn.server, home).GET("/v1/context")).data,
    );
    if (actor.developer.role === "organization_admin") {
      const members = z
        .array(memberSchema)
        .parse(
          (await apiClient(conn.server, home).GET("/v1/organization/members"))
            .data,
        );
      for (const member of members) {
        const origin = {
          type: "dev" as const,
          id: member.id,
          slug: member.slug,
          name: member.name,
          canPublish: true,
        };
        if (matchesOrigin(origin, selector, conn)) matches.push(origin);
      }
    }
  }
  const match = only(matches);
  if (!match)
    throw new CliError(
      `No scope named ${selector} that you can use.`,
      "barndog sets list",
    );
  return match;
}

export async function download(
  path: string,
  conn: Connection,
  home = homedir(),
  commit?: string,
  kind: PackageKind = "skill",
) {
  const response = await serverFetch(conn.server, home)(
    `${conn.server}${packagePath(path, kind)}`,
    { signal: AbortSignal.timeout(30000) },
  );
  if (!response.ok)
    throw new Error(`Package download failed (${response.status})`);
  if (commit && response.headers.get("etag") !== `"${commit}"`)
    throw new Error("Package revision does not match metadata");
  if (!response.body) throw new Error("Missing package body");
  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > defaultLimits.compressed) throw new Error("PACKAGE_TOO_LARGE");
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
export const packageCatalogs: Record<
  PackageKind,
  (conn: Connection, home: string) => Promise<(Skill | Hook)[]>
> = { skill: catalog, hook: publishedHooks };
