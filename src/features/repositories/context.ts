import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { z } from "zod";
import {
  normalizeRepositoryRemote,
  repositorySchema,
  teamSchema,
} from "@barndog-ai/api-contract";
import type { Connection } from "../../config/settings.js";
import { connection } from "../collaboration/remote.js";
import { request } from "../environment/remote.js";

const execute = promisify(execFile);

export async function localRepository(cwd = process.cwd()) {
  const git = async (...args: string[]) =>
    (
      await execute("git", ["-C", cwd, ...args], {
        timeout: 5000,
        maxBuffer: 65536,
      })
    ).stdout.trim();
  let root: string;
  try {
    root = await git("rev-parse", "--show-toplevel");
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      /not a git repository/.test(String((error as { stderr?: string }).stderr))
    )
      return { root: null, remotes: [] as string[] };
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
      if (key) remotes.add(key);
    }
  }
  return { root, remotes: [...remotes] };
}

export async function repositoryContext(
  home = homedir(),
  cwd = process.cwd(),
  expected?: Connection,
) {
  const local = await localRepository(cwd);
  const conn = expected ?? (await connection(home));
  const repositories = await request(
    conn,
    "/v1/repositories",
    z.array(repositorySchema),
    home,
  );
  const matches = repositories.filter(
    (repo) => repo.gitRemote && local.remotes.includes(repo.gitRemote),
  );
  const repository = matches.length === 1 ? matches[0]! : null;
  const teams = repository
    ? await request(conn, "/v1/teams", z.array(teamSchema), home)
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
