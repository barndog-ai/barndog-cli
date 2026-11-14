import { MAX_ASSET_NAME_LENGTH } from "../shared/constants.js";

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { type SelectionState, selectionStateSchema } from "./selection.js";
import { isHarness, type Harness } from "../harnesses/registry.js";
import { errorCode } from "../shared/values.js";
import { NAME, UUID_V4 } from "../shared/patterns.js";
import { writeAtomic } from "../shared/files.js";
import { CliError } from "../errors.js";

export class SetupRequiredError extends Error {
  constructor() {
    super("Harness selection is not configured.");
    this.name = "SetupRequiredError";
  }
}

/**
 * Saved server origin and organization/developer identity used to bind remote
 * operations.
 */
export type Connection = {
  server: string;
  organizationId: string;
  developerId: string;
};

/** A team workspace kept in one Git repository. */
export type GitWorkspace = {
  url: string;
  branch: string;
  workspaceId: string;
};

/** A workspace in a folder on this machine, in the same layout as a Git workspace. */
export type LocalWorkspace = {
  path: string;
  workspaceId: string;
};

/** `~/.barndog/config.yaml`. */
export type Settings = {
  harnesses: Harness[];
  connection?: Connection;
  gitWorkspace?: GitWorkspace;
  localWorkspace?: LocalWorkspace;
  environment?: SelectionState;
  knowledge?: boolean;
  /** Installed names that differ from the published name, keyed by asset ID. */
  localNames?: Record<string, string>;
};

export function settingsPath(home = homedir()): string {
  return join(home, ".barndog", "config.yaml");
}

const uuid = z.string().regex(UUID_V4);

const connectionSchema = z.looseObject({
  server: z.string().regex(/^https?:\/\//),
  organizationId: z.string(),
  developerId: z.string(),
});

const gitWorkspaceSchema = z.looseObject({
  url: z
    .string()
    .min(1)
    .refine((url) => !url.startsWith("-")),
  branch: z.string().min(1),
  workspaceId: uuid,
});

const localWorkspaceSchema = z.looseObject({
  path: z.string().refine(isAbsolute),
  workspaceId: uuid,
});

const localNamesSchema = z.record(
  uuid,
  z.string().regex(NAME).max(MAX_ASSET_NAME_LENGTH),
);

/** Every part of the file; each optional key is named only here. */
// Loose objects keep keys this version doesn't know, as the file had them.
const settingsSchema = z.looseObject({
  harnesses: z
    .array(z.custom<Harness>(isHarness))
    .refine((list) => new Set(list).size === list.length),
  connection: connectionSchema.optional(),
  gitWorkspace: gitWorkspaceSchema.optional(),
  localWorkspace: localWorkspaceSchema.optional(),
  // Lazy: config/environment.ts imports this module, so its schema isn't ready yet.
  environment: z.lazy(() => selectionStateSchema).optional(),
  knowledge: z.boolean().optional(),
  localNames: localNamesSchema.optional(),
});

const invalidSettings =
  "harnesses must list each of claude, codex and cursor at most once";

type SettingsField = keyof z.infer<typeof settingsSchema>;

/** What to say about an invalid part, keyed by the field Zod reports it under. */
const invalidPart: Partial<Record<SettingsField, string>> = {
  harnesses: invalidSettings,
  connection: "the server connection is invalid",
  gitWorkspace: "gitWorkspace is invalid",
  localWorkspace: "localWorkspace is invalid",
  environment: "the asset selection is invalid",
  knowledge: "knowledge must be true or false",
  localNames: "localNames must map asset IDs to lowercase hyphenated names",
};

const isInvalidPart = (key: unknown): key is SettingsField =>
  typeof key === "string" && Object.hasOwn(invalidPart, key);

function validate(value: unknown): Settings {
  const result = settingsSchema.safeParse(value);
  if (!result.success) {
    const field = result.error.issues[0]?.path[0];
    throw new Error(
      (isInvalidPart(field) && invalidPart[field]) || invalidSettings,
    );
  }

  // Keys older files had (a format `version` and a `skills` list) are left
  // out here, so the next save removes them.
  const { version, skills, ...settings } = result.data;
  void version;
  void skills;
  const { connection, gitWorkspace, localWorkspace, environment } = settings;
  if (connection && gitWorkspace) {
    throw new Error("use only one of connection and gitWorkspace");
  }

  const selectsRemoteAssets =
    environment &&
    (environment.subscriptions.length ||
      environment.individualAssetIds.length) &&
    !gitWorkspace &&
    !localWorkspace;

  if (selectsRemoteAssets && !connection) {
    throw new Error("assets selected from a server need a connection");
  }

  return settings;
}

/**
 * Reads and validates YAML settings at the given path; a missing file returns
 * null, malformed settings throw.
 */
export async function readSettings(
  home = homedir(),
  path = settingsPath(home),
): Promise<Settings | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }

    throw error;
  }

  try {
    return validate(parse(text));
  } catch (error) {
    // Someone edited the file by hand; saving runs the same checks as a guard.
    throw new CliError(
      `${path} isn't valid: ${error instanceof Error ? error.message : String(error)}. Fix it, or move it aside and set up again.`,
      `mv ${path} ${path}.bak && barndog init`,
      { cause: error },
    );
  }
}

/** The file's text, after checking the settings are valid. */
export function settingsText(settings: Settings): string {
  validate(settings);

  return stringify(settings);
}

/**
 * Validates and atomically writes settings under the supplied home directory.
 */
export async function saveSettings(
  settings: Settings,
  home = homedir(),
): Promise<void> {
  const text = settingsText(settings);
  const path = settingsPath(home);
  await writeAtomic(path, text);
}
