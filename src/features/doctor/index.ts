import { homedir } from "node:os";
import {
  readSettings,
  settingsPath,
  type GitWorkspace,
} from "../../config/settings.js";
import { remoteHead } from "../git-workspace/git.js";
import { branchProtected } from "../git-workspace/publish.js";
import { readFetchState } from "../git-workspace/source.js";
import { CliError } from "../../errors.js";
import { detectHarnesses } from "../../harnesses/detect.js";
import { adapters } from "../../harnesses/registry.js";
import { authStatus } from "../auth/session.js";
import { LoginRequiredError } from "../auth/transport.js";
import { synchronize } from "../environment/sync.js";

export type Check = {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
};

const failure = (error: unknown) => ({
  detail: error instanceof Error ? error.message : String(error),
  fix: error instanceof CliError ? error.hint : undefined,
});

async function gitChecks(workspace: GitWorkspace, home: string) {
  const checks: Check[] = [];
  try {
    await remoteHead(workspace.url);
    checks.push({
      name: "Git access",
      status: "ok",
      detail: workspace.url,
    });
  } catch (error) {
    checks.push({ name: "Git access", status: "fail", ...failure(error) });
    return checks;
  }
  const state = await readFetchState(workspace.workspaceId, home);
  checks.push({
    name: "Last fetch",
    status: state.fetchedAt ? "ok" : "warn",
    detail: state.fetchedAt
      ? new Date(state.fetchedAt).toLocaleString()
      : "Never fetched.",
    fix: state.fetchedAt ? undefined : "barndog sync",
  });
  const protectedBranch = await branchProtected(
    workspace.url,
    workspace.branch,
  );
  if (protectedBranch !== true)
    checks.push({
      name: "Branch protection",
      status: "warn",
      detail:
        protectedBranch === false
          ? `${workspace.branch} isn't protected, so anyone who can push can install code on every teammate's machine. Protect it on the Git host.`
          : `BarnDog can't tell whether ${workspace.branch} is protected on this host. Make sure it is.`,
    });
  return checks;
}

/** Every check runs; one failure never hides the others. */
export async function doctor(home = homedir()): Promise<Check[]> {
  const checks: Check[] = [];
  let settings;
  try {
    settings = await readSettings(home);
  } catch (error) {
    checks.push({ name: "Configuration", status: "fail", ...failure(error) });
    return checks;
  }
  if (!settings) {
    checks.push({
      name: "Configuration",
      status: "fail",
      detail: "BarnDog isn't set up on this machine.",
      fix: "barndog init",
    });
    return checks;
  }
  checks.push({
    name: "Configuration",
    status: "ok",
    detail: settingsPath(home),
  });
  const detected = await detectHarnesses({ home });
  for (const harness of settings.harnesses) {
    const found = detected.find((d) => d.id === harness)?.evidence;
    checks.push({
      name: adapters[harness].name,
      status: found ? "ok" : "warn",
      detail:
        found ??
        "Not found on this machine; assets are still installed for it.",
      fix: found ? undefined : "barndog init",
    });
  }
  const connected = settings.version === 2 ? settings.connection : undefined;
  if (connected) {
    try {
      const session = await authStatus(home, connected.server);
      checks.push({
        name: "Session",
        status: "ok",
        detail: `${session.context.developer.name} · ${session.context.organization.name} · ${session.server}`,
      });
    } catch (error) {
      checks.push({
        name: "Session",
        status: "fail",
        ...(error instanceof LoginRequiredError
          ? { detail: "Not signed in.", fix: "barndog login" }
          : failure(error)),
      });
      return checks;
    }
  }
  if (settings.version === 2 && settings.gitWorkspace)
    checks.push(...(await gitChecks(settings.gitWorkspace, home)));
  try {
    const events = await synchronize(undefined, home, undefined, {
      dryRun: true,
      prompt: false,
    });
    const pending = events.filter(
      (e) =>
        e.type === "installed" ||
        e.type === "updated" ||
        e.type === "removed" ||
        (e.type === "native" && e.action !== "unchanged"),
    ).length;
    checks.push({
      name: "Installation",
      status: pending ? "warn" : "ok",
      detail: pending
        ? `${pending} pending ${pending === 1 ? "change" : "changes"}`
        : "Everything selected is installed and up to date.",
      fix: pending ? "barndog sync" : undefined,
    });
    for (const event of events) {
      if (event.type === "notice")
        checks.push({ name: "Notice", status: "warn", detail: event.message });
      if (event.type === "clash")
        checks.push({
          name: "Name clash",
          status: "warn",
          detail: `${event.skipped.origin} ${event.skipped.name} is skipped: ${event.installed.origin} already installs a ${event.kind === "skill" ? "Skill" : "MCP server"} with that name.`,
          fix: `barndog ${event.kind === "skill" ? "skills" : "mcp"} rename ${event.skipped.name} --origin ${event.skipped.origin} --as ${event.skipped.rename}`,
        });
      if (event.type === "invalid")
        checks.push({
          name: "Invalid asset",
          status: "warn",
          detail: `${event.kind} ${event.name}: ${event.reason}. The installed version stays in place.`,
        });
      if (event.type === "unsupported")
        checks.push({
          name: "Unsupported",
          status: "warn",
          detail: `${event.kind} ${event.name} on ${adapters[event.harness].name}: ${event.reason}`,
        });
    }
  } catch (error) {
    checks.push({ name: "Installation", status: "fail", ...failure(error) });
  }
  return checks;
}
