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

export type SkillSelection = { id: string; source: string; enabled: boolean };

export class SetupRequiredError extends Error {
  constructor() {
    super("Harness selection is not configured.");
    this.name = "SetupRequiredError";
  }
}

export type LegacySettings = {
  version: 1;
  harnesses: Harness[];
  skills: SkillSelection[];
};

export type LocalSelection = SkillSelection & { kind: "local" };

export type ApiSelection = { kind: "api"; id: string; enabled: boolean };

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

export type SettingsV2 = {
  version: 2;
  harnesses: Harness[];
  skills: (LocalSelection | ApiSelection)[];
  connection?: Connection;
  gitWorkspace?: GitWorkspace;
  localWorkspace?: LocalWorkspace;
  environment?: SelectionState;
  knowledge?: boolean;
  /** Installed names that differ from the published name, keyed by asset ID. */
  localNames?: Record<string, string>;
};

export type Settings = LegacySettings | SettingsV2;

export function upgradeSettings(settings: Settings): SettingsV2 {
  return settings.version === 2
    ? settings
    : {
        ...settings,
        version: 2,
        skills: settings.skills.map((skill) => ({ ...skill, kind: "local" })),
      };
}

export function settingsPath(home = homedir()): string {
  return join(home, ".barndog", "config.yaml");
}

const uuid = z.string().regex(UUID_V4);

// Loose objects keep keys this version doesn't know, as the file had them.
const headerSchema = z.looseObject({
  version: z.union([z.literal(1), z.literal(2)]),
  harnesses: z
    .array(z.custom<Harness>(isHarness))
    .refine((list) => new Set(list).size === list.length),
  skills: z.array(z.unknown()),
});

const legacySkillSchema = z.looseObject({
  id: z.string(),
  source: z.string(),
  enabled: z.boolean(),
});

const skillSchema = z.union([
  z.looseObject({
    kind: z.literal("local"),
    id: uuid,
    enabled: z.boolean(),
    source: z.string().refine((source) => source.trim() !== ""),
  }),
  z.looseObject({ kind: z.literal("api"), id: uuid, enabled: z.boolean() }),
]);

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

/** Every part of a version-2 file; each optional key is named only here. */
const settingsV2Schema = headerSchema.extend({
  version: z.literal(2),
  skills: z.array(skillSchema),
  connection: connectionSchema.optional(),
  gitWorkspace: gitWorkspaceSchema.optional(),
  localWorkspace: localWorkspaceSchema.optional(),
  // Lazy: config/environment.ts imports this module, so its schema isn't ready yet.
  environment: z.lazy(() => selectionStateSchema).optional(),
  knowledge: z.boolean().optional(),
  localNames: localNamesSchema.optional(),
});

const invalidSkill = "Invalid user settings: invalid skill selection";

/** What to say about an invalid part, keyed by the field Zod reports it under. */
const invalidPart = {
  skills: invalidSkill,
  connection: "Invalid user settings: invalid server connection",
  gitWorkspace: "Invalid user settings: invalid Git workspace",
  localWorkspace: "Invalid user settings: invalid local workspace",
  environment: "Invalid user settings: invalid asset selection",
  knowledge: "Invalid knowledge integration setting",
  localNames:
    "Invalid user settings: localNames maps asset IDs to lowercase hyphenated names",
} satisfies Partial<Record<keyof typeof settingsV2Schema.shape, string>>;

const isInvalidPart = (key: unknown): key is keyof typeof invalidPart =>
  typeof key === "string" && Object.hasOwn(invalidPart, key);

/** Parses one part of the settings, failing with `message` instead of Zod's issues. */
function part<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(message);
  return result.data;
}

function validate(value: unknown): Settings {
  const header = part(
    headerSchema,
    value,
    "Invalid user settings: expected version: 1 or 2, a unique harnesses list (claude, codex, cursor), and a skills array",
  );
  if (header.version === 1)
    return {
      ...header,
      version: 1,
      skills: part(z.array(legacySkillSchema), header.skills, invalidSkill),
    };
  const result = settingsV2Schema.safeParse(header);
  if (!result.success) {
    const field = result.error.issues[0]?.path[0];
    throw new Error(
      isInvalidPart(field) ? invalidPart[field] : "Invalid user settings",
    );
  }
  const settings = result.data;
  const { skills, connection, gitWorkspace, localWorkspace, environment } =
    settings;
  if (
    new Set(skills.map((skill) => skill.id.toLowerCase())).size !==
    skills.length
  )
    throw new Error("Invalid user settings: duplicate Skill ID");
  if (connection && gitWorkspace)
    throw new Error(
      "Invalid user settings: use only one of connection and gitWorkspace",
    );
  const selectsRemoteAssets =
    skills.some((skill) => skill.kind === "api") ||
    (environment &&
      (environment.subscriptions.length ||
        environment.individualAssetIds.length) &&
      !gitWorkspace &&
      !localWorkspace);
  if (selectsRemoteAssets && !connection)
    throw new Error(
      "Invalid user settings: API selections require a connection",
    );
  return settings;
}

export async function readSettings(
  home = homedir(),
  path = settingsPath(home),
): Promise<Settings | null> {
  try {
    return validate(parse(await readFile(path, "utf8")));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

export async function saveSettings(
  settings: Settings,
  home = homedir(),
): Promise<void> {
  validate(settings);
  const path = settingsPath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, stringify(settings), { mode: 0o600 });
  await rename(temporary, path);
}
