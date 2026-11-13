import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parse } from "yaml";
import type { SkillSelection } from "../../config/settings.js";
import { NAME, splitFrontMatter, UUID_V4 } from "../../shared/patterns.js";
import { isRecord } from "../../shared/values.js";

export function validateSelection(
  value: unknown,
): asserts value is SkillSelection {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !UUID_V4.test(value.id) ||
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
  const yaml = splitFrontMatter(text)?.yaml;
  const metadata: unknown = yaml === undefined ? null : parse(yaml);
  if (
    !isRecord(metadata) ||
    typeof metadata.name !== "string" ||
    !NAME.test(metadata.name) ||
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
