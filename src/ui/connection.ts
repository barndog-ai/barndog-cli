import input from "@inquirer/input";
import select from "@inquirer/select";
import { defaultServer } from "../config/build.js";
import { normalizeServer } from "../features/auth/transport.js";
import { checkRepositoryUrl } from "../features/workspace/git.js";
import { promptTheme } from "./theme.js";

/**
 * Asks for the workspace URL, offering `current` or the build's default server.
 */
export async function promptServer(current?: string): Promise<string> {
  return normalizeServer(
    await input({
      message: "BarnDog workspace URL (cloud or self-hosted)",
      default: current ?? defaultServer,
      validate: (value) => {
        try {
          normalizeServer(value.trim());

          return true;
        } catch {
          return "Enter an HTTPS server origin, such as https://barndog.example.com (HTTP is allowed for localhost).";
        }
      },
      transformer: (value) => value.trim(),
      theme: promptTheme,
    }).then((value) => value.trim()),
  );
}

export type SetupChoice =
  | { kind: "local" }
  | { kind: "git"; url: string }
  | { kind: "cloud"; server: string };

/** Asks where to keep assets, defaulting to `current`. */
export async function chooseConnection(
  current?: SetupChoice,
): Promise<SetupChoice> {
  const kind = await select<SetupChoice["kind"]>({
    loop: false,
    message: "Where should BarnDog keep your assets?",
    default: current?.kind,
    choices: [
      {
        name: "This machine only",
        value: "local",
        description:
          "Sync your AI configuration across all the coding tools on this machine. No account, no sharing.",
      },
      {
        name: "Git repo",
        value: "git",
        description:
          "Share assets through one repo on any Git host. For small teams: reviews are pull requests, with no roles or web workspace.",
      },
      {
        name: "BarnDog Cloud Workspace",
        value: "cloud",
        description:
          "Workspace, roles and permissions, reviews and a web UI. Sign in to BarnDog cloud or your own server.",
      },
    ],
    theme: promptTheme,
  });

  if (kind === "local") {
    return { kind };
  }

  if (kind === "cloud") {
    return {
      kind,
      server: await promptServer(
        current?.kind === "cloud" ? current.server : undefined,
      ),
    };
  }

  return {
    kind,
    url: (
      await input({
        message: "Git repository URL",
        default: current?.kind === "git" ? current.url : undefined,
        validate: (value) => {
          try {
            checkRepositoryUrl(value);

            return true;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        },
        theme: promptTheme,
      })
    ).trim(),
  };
}

/**
 * What happens to local assets when the machine connects to a workspace: keep
 * them private beside it, share a copy and keep them, move them in so the
 * shared copy is the only one, or leave them inactive.
 */
export type LocalAssetChoice = "keep" | "copy" | "move" | "leave";

export function chooseLocalAssets(count: number): Promise<LocalAssetChoice> {
  return select<LocalAssetChoice>({
    message: `You have ${count} local asset${count === 1 ? "" : "s"}. What should happen to ${count === 1 ? "it" : "them"}?`,
    choices: [
      {
        name: "Keep active, private to this machine",
        value: "keep",
        description:
          "They keep working next to the shared assets. Move them any time with barndog local move.",
      },
      {
        name: "Share a copy, and keep them here too",
        value: "copy",
        description:
          "The local ones stay as separate assets. Anything whose name is already taken is left out and listed.",
      },
      {
        name: "Move them to the new workspace",
        value: "move",
        description:
          "The shared copies become the only ones; the local ones are removed once they exist. Anything whose name is already taken stays local and is listed.",
      },
      {
        name: "Stop using them",
        value: "leave",
        description:
          "They're uninstalled, but the folder stays on disk untouched.",
      },
    ],
    theme: promptTheme,
  });
}

export function chooseMoveTarget(
  targets: { value: string; name: string }[],
): Promise<string> {
  return select<string>({
    message: "Where should they go?",
    choices: targets,
    theme: promptTheme,
  });
}
