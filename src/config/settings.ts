import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { SelectionState } from "../features/asset-selection/types.js";
import { selectionStateSchema } from "./environment.js";
import { isHarness, type Harness } from "../harnesses/registry.js";
import { errorCode } from "../errors.js";
import { NAME, UUID_V4 } from "../shared/patterns.js";

export class SetupRequiredError extends Error {
  constructor() {
    super("Harness selection is not configured.");
    this.name = "SetupRequiredError";
  }
}

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

const localNamesSchema = z.record(uuid, z.string().regex(NAME).max(64));

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
  "Invalid user settings: expected a unique harnesses list (claude, codex, cursor)";

type SettingsField = keyof z.infer<typeof settingsSchema>;

/** What to say about an invalid part, keyed by the field Zod reports it under. */
const invalidPart: Partial<Record<SettingsField, string>> = {
  harnesses: invalidSettings,
  connection: "Invalid user settings: invalid server connection",
  gitWorkspace: "Invalid user settings: invalid Git workspace",
  localWorkspace: "Invalid user settings: invalid local workspace",
  environment: "Invalid user settings: invalid asset selection",
  knowledge: "Invalid knowledge integration setting",
  localNames:
    "Invalid user settings: localNames maps asset IDs to lowercase hyphenated names",
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
    throw new Error(
      "Invalid user settings: use only one of connection and gitWorkspace",
    );
  }

  const selectsRemoteAssets =
    environment &&
    (environment.subscriptions.length ||
      environment.individualAssetIds.length) &&
    !gitWorkspace &&
    !localWorkspace;

  if (selectsRemoteAssets && !connection) {
    throw new Error(
      "Invalid user settings: API selections require a connection",
    );
  }

  return settings;
}

export async function readSettings(
  home = homedir(),
  path = settingsPath(home),
): Promise<Settings | null> {
  try {
    return validate(parse(await readFile(path, "utf8")));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }

    throw error;
  }
}

/** The file's text, after checking the settings are valid. */
export function settingsText(settings: Settings): string {
  validate(settings);

  return stringify(settings);
}

export async function saveSettings(
  settings: Settings,
  home = homedir(),
): Promise<void> {
  const text = settingsText(settings);
  const path = settingsPath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
}
