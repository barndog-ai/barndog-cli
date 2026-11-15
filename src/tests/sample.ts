import { z } from "zod";

/** Values for fields whose schema has a format a generic string wouldn't pass. */
const named: Record<string, unknown> = {
  commit: "a".repeat(40),
  head: "b".repeat(40),
  base: "c".repeat(40),
  syncedCommit: "a".repeat(40),
  submittedCommit: "b".repeat(40),
  name: "release-notes",
  slug: "acme",
  title: "Update release-notes",
  description: "Writes release notes",
  url: "https://example.test/page",
  htmlUrl: "https://github.test/acme/skills/pull/7",
  sourceUrl: "https://example.test/source",
  gitRemote: "github.com/acme/app",
  repository: "skills",
  owner: "acme",
  path: "SKILL.md",
  patch: "@@ -1 +1 @@\n-old\n+new\n",
  content: Buffer.from("---\nname: release-notes\n---\n").toString("base64"),
  email: "alice@example.test",
};

type Def = {
  type: string;
  format?: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  entries?: Record<string, string>;
  values?: unknown[];
  options?: z.ZodType[];
  innerType?: z.ZodType;
  valueType?: z.ZodType;
  in?: z.ZodType;
  left?: z.ZodType;
  right?: z.ZodType;
};

const definition = (schema: z.ZodType) => schema.def as unknown as Def;

function sampleString(def: Def, key: string | undefined, id: string) {
  if (def.format === "uuid" || def.format === "guid") {
    return id;
  }

  if (def.format === "datetime") {
    return "2026-01-02T03:04:05.000Z";
  }

  if (def.format === "url") {
    return "https://example.test/page";
  }

  if (def.format === "email") {
    return "alice@example.test";
  }

  if (key && typeof named[key] === "string") {
    return named[key];
  }

  return key ?? "text";
}

/**
 * A value the schema accepts, built from its shape: the first option of every
 * enum and union, one element per array, optional fields present. Every UUID
 * is `id`, so related records line up. `overrides` replaces top-level fields.
 */
export function sample<T extends z.ZodType>(
  schema: T,
  overrides: Record<string, unknown> = {},
  id = "11111111-1111-4111-8111-111111111111",
): z.infer<T> {
  const build = (node: z.ZodType, key?: string): unknown => {
    const def = definition(node);

    switch (def.type) {
      case "string":
        return sampleString(def, key, id);
      case "number":
      case "int":
        return 1;
      case "boolean":
        return true;
      case "null":
        return null;
      case "literal":
        return def.values?.[0];
      case "enum":
        return Object.values(def.entries ?? {})[0];
      case "array":
        return def.element ? [build(def.element, key)] : [];
      case "object":
        return Object.fromEntries(
          Object.entries(def.shape ?? {}).map(([name, child]) => [
            name,
            build(child, name),
          ]),
        );
      case "record":
        return def.valueType ? { SAMPLE: build(def.valueType, key) } : {};
      case "union":
        return def.options?.[0] ? build(def.options[0], key) : undefined;
      case "intersection":
        return {
          ...(def.left ? (build(def.left, key) as object) : {}),
          ...(def.right ? (build(def.right, key) as object) : {}),
        };
      case "optional":
      case "nullable":
      case "default":
      case "readonly":
      case "catch":
      case "nonoptional":
        return def.innerType ? build(def.innerType, key) : undefined;
      case "pipe":
        return def.in ? build(def.in, key) : undefined;
      case "lazy":
      case "any":
      case "unknown":
        return {};
      default:
        throw new Error(`sample() doesn't know the schema type ${def.type}`);
    }
  };

  const value = build(schema);

  return schema.parse(
    value && typeof value === "object" && !Array.isArray(value)
      ? { ...value, ...overrides }
      : value,
  ) as z.infer<T>;
}
