import { homedir } from "node:os";
import { contextSchema } from "@barndog-ai/api-contract";

import { readSettings, type Connection } from "../../config/settings.js";
import { CliError } from "../../errors.js";
import { apiClient } from "../auth/transport.js";

/**
 * The saved Cloud connection, after asking the server who is signed in and
 * checking it is still that organization and developer. Pass `expected` to also
 * require a particular connection, such as the one a working copy was made
 * with. Fails with a fix in a Git or local workspace, which has no server.
 */
export async function connection(home = homedir(), expected?: Connection) {
  const settings = await readSettings(home);
  if (
    settings &&
    !settings.connection &&
    (settings.gitWorkspace || settings.localWorkspace)
  ) {
    throw new CliError(
      `This needs a BarnDog Cloud Workspace. This machine keeps its assets in ${settings.gitWorkspace ? "a Git repo" : "a local folder"}.`,
      settings.gitWorkspace
        ? "barndog migrate --to <server>"
        : "barndog init --server <url>",
    );
  }

  if (!settings || !settings.connection) {
    throw new CliError(
      "This machine isn't connected to a BarnDog workspace.",
      "barndog init",
    );
  }

  const saved = settings.connection;
  if (
    expected &&
    (expected.server !== saved.server ||
      expected.organizationId !== saved.organizationId ||
      expected.developerId !== saved.developerId)
  ) {
    throw new CliError(
      "This working copy belongs to another server, organization or developer than the one you're signed in to.",
      "barndog whoami",
    );
  }

  const actor = contextSchema.parse(
    (await apiClient(saved.server, home).GET("/v1/context")).data,
  );

  if (
    actor.organization.id !== saved.organizationId ||
    actor.developer.id !== saved.developerId
  ) {
    throw new CliError(
      "You're signed in as a different organization or developer than this machine was set up with.",
      "barndog login",
    );
  }

  return saved;
}
