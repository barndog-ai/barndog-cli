import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import type { SelectionState } from "../features/asset-selection/types.js";
import { selectionStateSchema } from "./environment.js";
import { isHarness, type Harness } from "../harnesses/registry.js";

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

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validate(value: unknown): Settings {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    (value.version !== 1 && value.version !== 2) ||
    !("harnesses" in value) ||
    !Array.isArray(value.harnesses) ||
    !value.harnesses.every(isHarness) ||
    new Set(value.harnesses).size !== value.harnesses.length ||
    !("skills" in value) ||
    !Array.isArray(value.skills)
  ) {
    throw new Error(
      "Invalid user settings: expected version: 1 or 2, a unique harnesses list (claude, codex, cursor), and a skills array",
    );
  }
  if (value.version === 2) {
    if ("environment" in value) selectionStateSchema.parse(value.environment);
    if ("knowledge" in value && typeof value.knowledge !== "boolean")
      throw new Error("Invalid knowledge integration setting");
    if (
      "localNames" in value &&
      (typeof value.localNames !== "object" ||
        value.localNames === null ||
        Array.isArray(value.localNames) ||
        Object.entries(value.localNames).some(
          ([id, name]) =>
            !uuidPattern.test(id) ||
            typeof name !== "string" ||
            !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
            name.length > 64,
        ))
    )
      throw new Error(
        "Invalid user settings: localNames maps asset IDs to lowercase hyphenated names",
      );
    for (const skill of value.skills) {
      if (
        !skill ||
        typeof skill !== "object" ||
        !["local", "api"].includes(skill.kind) ||
        typeof skill.id !== "string" ||
        !uuidPattern.test(skill.id) ||
        typeof skill.enabled !== "boolean" ||
        (skill.kind === "local" &&
          (typeof skill.source !== "string" || !skill.source.trim()))
      )
        throw new Error("Invalid user settings: invalid skill selection");
    }
    if (
      new Set(value.skills.map((skill) => skill.id.toLowerCase())).size !==
      value.skills.length
    )
      throw new Error("Invalid user settings: duplicate Skill ID");
    const connection =
      "connection" in value ? (value.connection as Connection) : undefined;
    if (
      connection &&
      (typeof connection.server !== "string" ||
        !/^https?:\/\//.test(connection.server) ||
        typeof connection.organizationId !== "string" ||
        typeof connection.developerId !== "string")
    )
      throw new Error("Invalid user settings: invalid server connection");
    const git =
      "gitWorkspace" in value
        ? (value.gitWorkspace as GitWorkspace)
        : undefined;
    const local =
      "localWorkspace" in value
        ? (value.localWorkspace as LocalWorkspace)
        : undefined;
    if (
      git &&
      (typeof git.url !== "string" ||
        !git.url ||
        git.url.startsWith("-") ||
        typeof git.branch !== "string" ||
        !git.branch ||
        !uuidPattern.test(git.workspaceId))
    )
      throw new Error("Invalid user settings: invalid Git workspace");
    if (
      local &&
      (typeof local.path !== "string" ||
        !isAbsolute(local.path) ||
        !uuidPattern.test(local.workspaceId))
    )
      throw new Error("Invalid user settings: invalid local workspace");
    if (connection && git)
      throw new Error(
        "Invalid user settings: use only one of connection and gitWorkspace",
      );
    if (value.skills.some((skill) => skill.kind === "api") && !connection)
      throw new Error(
        "Invalid user settings: API selections require a connection",
      );
    if (
      "environment" in value &&
      (() => {
        const state = selectionStateSchema.parse(value.environment);
        return state.subscriptions.length || state.individualAssetIds.length;
      })() &&
      !connection &&
      !git &&
      !local
    )
      throw new Error(
        "Invalid user settings: API selections require a connection",
      );
  }
  return value as Settings;
}

export async function readSettings(
  home = homedir(),
  path = settingsPath(home),
): Promise<Settings | null> {
  try {
    return validate(parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
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
