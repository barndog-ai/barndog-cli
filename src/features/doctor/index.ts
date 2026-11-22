import type { RuntimeContext } from "../../runtime.js";
import { readSettings, type GitWorkspace } from "../../config/settings.js";
import { remoteHead } from "../workspace/git.js";
import { branchProtected } from "../workspace/publish.js";
import { readFetchState } from "../workspace/repo-source.js";
import { CliError } from "../../errors.js";
import { detectHarnesses } from "../../harnesses/detect.js";
import { adapters } from "../../harnesses/registry.js";
import { authStatus } from "../auth/session.js";
import { LoginRequiredError } from "../auth/transport.js";
import { synchronize } from "../environment/sync.js";
import { assetKinds } from "../asset-kinds/index.js";
import { barndogPaths } from "../../config/paths.js";
import {
  unassignedValueMessage,
  unsetValueMessage,
  type SyncEvent,
} from "../environment/events.js";

export type Check = {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
  /** A command that deletes or changes something; `fix` says it in words. */
  command?: string;
};

/** An MCP variable with no value on this machine, or a kept value no server has. */
function variableCheck(event: SyncEvent): Check[] {
  if (event.type === "unassigned-value") {
    return [
      {
        name: "MCP variable",
        status: "warn",
        detail: unassignedValueMessage(event.variable),
        fix: `barndog mcp env set <server> ${event.variable}`,
      },
    ];
  }

  if (event.type !== "unset-variable") {
    return [];
  }

  return [
    {
      name: "MCP variable",
      status: "warn",
      detail: `${unsetValueMessage(event)} BarnDog doesn't keep it and it isn't set in this shell. Coding tools opened outside a terminal may not see your shell's variables either.`,
      fix: `barndog mcp env set ${event.server} ${event.variable}`,
    },
  ];
}

const failure = (error: unknown) => ({
  detail: error instanceof Error ? error.message : String(error),
  fix: error instanceof CliError ? error.hint : undefined,
  command: error instanceof CliError ? error.command : undefined,
});

async function gitChecks(workspace: GitWorkspace, runtime: RuntimeContext) {
  const checks: Check[] = [];
  try {
    await remoteHead(workspace.url, runtime);
    checks.push({
      name: "Git access",
      status: "ok",
      detail: workspace.url,
    });
  } catch (error) {
    checks.push({ name: "Git access", status: "fail", ...failure(error) });
  }

  // Read locally, so it still helps when the remote can't be reached.
  const state = await readFetchState(workspace.workspaceId, runtime);
  checks.push({
    name: "Last fetch",
    status: state.fetchedAt ? "ok" : "warn",
    detail: state.fetchedAt
      ? new Date(state.fetchedAt).toLocaleString()
      : "Never fetched.",
    fix: state.fetchedAt ? undefined : "barndog sync",
  });

  if (checks.some((check) => check.status === "fail")) {
    return checks;
  }

  const protectedBranch = await branchProtected(
    workspace.url,
    workspace.branch,
    runtime,
  );

  if (protectedBranch !== true) {
    checks.push({
      name: "Branch protection",
      status: "warn",
      detail:
        protectedBranch === false
          ? `${workspace.branch} isn't protected, so anyone who can push can install code on every teammate's machine. Protect it on the Git host.`
          : `BarnDog can't tell whether ${workspace.branch} is protected on this host. Make sure it is.`,
    });
  }

  return checks;
}

/**
 * Runs every check that can run: a failure hides only the checks that need
 * what failed (a readable configuration, a session).
 */
export async function doctor(runtime: RuntimeContext): Promise<Check[]> {
  const { home } = runtime;

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
    detail: barndogPaths(home).settings,
  });

  const detected = await detectHarnesses(runtime);
  for (const harness of settings.harnesses) {
    const { name } = adapters[harness];
    const found = detected.find((d) => d.id === harness)?.evidence;
    if (found) {
      checks.push({ name, status: "ok", detail: found });
      continue;
    }

    // Disabling removes what BarnDog installed there, so it goes in `command`.
    checks.push({
      name,
      status: "warn",
      detail: "Not found on this machine; assets are still installed for it.",
      fix: `Install ${name}, or stop BarnDog installing for it.`,
      command: `barndog harnesses disable ${harness}`,
    });
  }

  const connected = settings.connection;
  if (connected) {
    try {
      const session = await authStatus(runtime, connected.server);
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

  if (settings.gitWorkspace) {
    checks.push(...(await gitChecks(settings.gitWorkspace, runtime)));
  }

  try {
    const events = await synchronize(undefined, runtime, undefined, {
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

    checks.push(...events.flatMap(variableCheck));
    for (const event of events) {
      if (event.type === "notice") {
        checks.push({ name: "Notice", status: "warn", detail: event.message });
      }

      if (event.type === "clash") {
        checks.push({
          name: "Name clash",
          status: "warn",
          detail: `${event.skipped.origin} ${event.skipped.name} is skipped: ${event.installed.origin} already installs ${assetKinds[event.kind].a} with that name.`,
          fix: `barndog ${assetKinds[event.kind].command} rename ${event.skipped.name} --origin ${event.skipped.origin} --as ${event.skipped.rename}`,
        });
      }

      if (event.type === "invalid") {
        checks.push({
          name: "Invalid asset",
          status: "warn",
          detail: `${event.kind} ${event.name}: ${event.reason}. The installed version stays in place.`,
        });
      }

      if (event.type === "unsupported") {
        checks.push({
          name: "Unsupported",
          status: "warn",
          detail: `${event.kind} ${event.name} on ${adapters[event.harness].name}: ${event.reason}`,
        });
      }
    }
  } catch (error) {
    checks.push({ name: "Installation", status: "fail", ...failure(error) });
  }

  return checks;
}
