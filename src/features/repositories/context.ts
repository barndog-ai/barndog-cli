import type { RuntimeContext } from "../../runtime.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  normalizeRepositoryRemote,
  repositorySchema,
  teamSchema,
} from "@barndog-ai/api-contract";
import type { Connection } from "../../config/settings.js";
import { connection } from "../server/connection.js";
import { parsed } from "../server/client.js";
import { errorCode } from "../../shared/values.js";
import { only } from "../../shared/lookup.js";
import { apiClient } from "../auth/transport.js";

const execute = promisify(execFile);

/**
 * Inspects the Git root and normalized fetch remotes at cwd without contacting
 * hosts; missing Git or repository yields no root.
 */
export async function localRepository(runtime: RuntimeContext) {
  const { cwd } = runtime;
  const git = async (...args: string[]) =>
    (
      await execute("git", ["-C", cwd, ...args], {
        timeout: 5000,
        env: { ...runtime.env },
        maxBuffer: 65536,
      })
    ).stdout.trim();

  let root: string;
  try {
    root = await git("rev-parse", "--show-toplevel");
  } catch (error) {
    if (
      errorCode(error) === "ENOENT" ||
      (error instanceof Error &&
        "stderr" in error &&
        /not a git repository/.test(String(error.stderr)))
    ) {
      return { root: null, remotes: [] as string[] };
    }

    throw error;
  }

  const names = (await git("remote")).split("\n").filter(Boolean);
  const remotes = new Set<string>();
  for (const name of names) {
    // Read configured fetch URLs without contacting a Git host or running hooks.
    for (const url of (await git("remote", "get-url", "--all", name)).split(
      "\n",
    )) {
      const key = normalizeRepositoryRemote(url);
      if (key) {
        remotes.add(key);
      }
    }
  }

  return { root, remotes: [...remotes] };
}

/**
 * Matches local remotes to server repositories and returns owning team and
 * policy scopes; multiple matches remain ambiguous.
 */
export async function repositoryContext(
  runtime: RuntimeContext,
  expected?: Connection,
) {
  const local = await localRepository(runtime);
  const conn = expected ?? (await connection(runtime));
  const client = apiClient(conn.server, runtime);
  const repositories = await parsed(
    z.array(repositorySchema),
    client.GET("/v1/repositories"),
  );

  const matches = repositories.filter(
    (repo) => repo.gitRemote && local.remotes.includes(repo.gitRemote),
  );

  const repository = only(matches) ?? null;
  const teams = repository
    ? await parsed(z.array(teamSchema), client.GET("/v1/teams"))
    : [];

  return {
    ...local,
    repository,
    team: teams.find((team) => team.id === repository?.teamId) ?? null,
    ambiguous: matches.length > 1,
    policyScopes: [
      { type: "org" as const, id: conn.organizationId },
      ...(repository ? [{ type: "team" as const, id: repository.teamId }] : []),
    ],
  };
}
