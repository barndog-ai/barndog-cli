import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parse } from "yaml";
import type { SkillSelection } from "../../config/settings.js";

export const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateSelection(
  value: unknown,
): asserts value is SkillSelection {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !uuid.test(value.id) ||
    typeof value.source !== "string" ||
    !value.source.trim() ||
    typeof value.enabled !== "boolean"
  ) {
    throw new Error(
      "Each skill requires a UUIDv4 id, source path, and boolean enabled",
    );
  }
}

export async function validateSkillSource(
  source: string,
): Promise<{ name: string; description: string }> {
  const text = await readFile(resolve(source, "SKILL.md"), "utf8");
  const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
    text,
  );
  const metadata: unknown = frontmatter ? parse(frontmatter[1]!) : null;
  if (
    !isRecord(metadata) ||
    typeof metadata.name !== "string" ||
    !skillName.test(metadata.name) ||
    metadata.name.length > 64 ||
    typeof metadata.description !== "string" ||
    !metadata.description.trim()
  ) {
    throw new Error(`Invalid SKILL.md name/description: ${source}`);
  }
  if (basename(source) !== metadata.name)
    throw new Error(`Skill directory must match name: ${metadata.name}`);
  return { name: metadata.name, description: metadata.description };
}
