import { homedir } from "node:os";
import { normalizeRepositoryRemote } from "@barndog-ai/api-contract";
import type { WorkspaceModel } from "../git-workspace/format.js";
import { authStatus } from "../auth/session.js";
import { readSettings } from "../../config/settings.js";
import { repositoryContext, localRepository } from "../repositories/context.js";
import { openRepoSource } from "../environment/workspace-source.js";
import { only } from "../../shared/lookup.js";

/** The barndog.yaml answer to "which repository scope is this folder?". */
async function declaredRepository(model: WorkspaceModel, cwd: string) {
  const local = await localRepository(cwd);
  const matches = Object.entries(model.config.repositories).filter(
    ([, repository]) =>
      repository.gitRemote &&
      local.remotes.includes(
        normalizeRepositoryRemote(repository.gitRemote) ?? "",
      ),
  );

  const [slug, declared] = only(matches) ?? [];
  const scope = (type: "team" | "repo", name: string | undefined) =>
    model.scopes.find((s) => s.type === type && s.slug === name);

  const repository = slug ? scope("repo", slug) : undefined;
  const team = scope("team", declared?.team);

  return {
    ...local,
    repository: repository
      ? { id: repository.id, slug: repository.slug, name: repository.name }
      : null,
    team: team ? { id: team.id, slug: team.slug, name: team.name } : null,
    ambiguous: matches.length > 1,
    policyScopes: [
      { type: "org" as const, id: model.organizationId },
      ...(team ? [{ type: "team" as const, id: team.id }] : []),
    ],
  };
}

/** The workspace's web address: the server this machine is signed in to. */
export async function workspaceUrl(home = homedir()) {
  return (await authStatus(home)).server;
}

/** How the Git repository in `cwd` maps to a BarnDog repository and its team. */
export async function repoStatus(home = homedir(), cwd = process.cwd()) {
  const settings = await readSettings(home);
  const repo = settings && openRepoSource(settings, home, { refresh: "auto" });
  if (repo) {
    return declaredRepository(await repo.model(), cwd);
  }

  return repositoryContext(home, cwd);
}
