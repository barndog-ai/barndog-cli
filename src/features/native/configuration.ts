import {
  parse as parseJson,
  parseTree,
  createScanner,
  SyntaxKind,
  findNodeAtLocation,
  modify,
  applyEdits,
  type ParseError,
} from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
// Two TOML libraries on purpose: smol-toml parses and writes values but keeps no
// source positions, and toml-eslint-parser (despite the name, a plain TOML parser
// that doesn't need ESLint) gives each table's range in the text. See tomlEdit().
import { parseForESLint } from "toml-eslint-parser";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import type { Harness } from "../../harnesses/types.js";
import { isRecord } from "../../shared/values.js";
import { CliError } from "../../errors.js";

/**
 * One owned native configuration entry, including its destination file and
 * serialized value.
 */
export type NativeEntry = {
  id: string;
  kind: "mcp" | "hook" | "knowledge" | "sync";
  harness: Harness;
  file: string;
  key: string;
  value: Record<string, unknown>;
};

/** Each harness's MCP configuration file, relative to the home directory. */
const mcpFiles: Record<Harness, string> = {
  claude: ".claude.json",
  codex: ".codex/config.toml",
  cursor: ".cursor/mcp.json",
};

/** Each harness's Hook settings file, relative to the home directory. */
const hookFiles: Record<Harness, string> = {
  claude: ".claude/settings.json",
  codex: ".codex/hooks.json",
  cursor: ".cursor/hooks.json",
};

/**
 * Resolves the native settings file under the supplied home; non-MCP entries
 * use the harness Hook file.
 */
export const nativeFile = (
  harness: Harness,
  kind: NativeEntry["kind"],
  home: string,
) => join(home, (kind === "mcp" ? mcpFiles : hookFiles)[harness]);

function object(value: unknown, file: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new CliError(
      `${file} doesn't hold the settings object BarnDog expects, so it was left unchanged. Fix it, then sync again.`,
      "barndog sync",
    );
  }

  return value;
}

function same(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  return isDeepStrictEqual(
    JSON.parse(JSON.stringify(left)),
    JSON.parse(JSON.stringify(right)),
  );
}

function json(text: string, file: string) {
  const errors: ParseError[] = [];
  const value: unknown = parseJson(text || "{}", errors, {
    allowTrailingComma: true,
  });

  if (errors.length) {
    throw new CliError(
      `${file} isn't valid JSON, so BarnDog left it unchanged. Fix it, then sync again.`,
      "barndog sync",
    );
  }

  return object(value, file);
}

/**
 * Replaces or removes one `[mcp_servers.<key>]` entry in Codex's config.toml by
 * cutting its source range out of the text, so comments and unrelated settings
 * survive. toml-eslint-parser finds the ranges; smol-toml writes the new entry
 * and checks the result still parses. Re-serializing the whole file with
 * smol-toml would drop every comment.
 */
function tomlEdit(
  text: string,
  key: string,
  value: Record<string, unknown> | undefined,
) {
  const ast = parseForESLint(text).ast;
  const ranges: [number, number][] = [];
  for (const node of ast.body[0].body) {
    if (node.type === "TOMLTable") {
      const path = node.resolvedKey;
      if (path[0] === "mcp_servers" && path[1] === key) {
        ranges.push(node.range);
      } else if (path.length === 1 && path[0] === "mcp_servers") {
        for (const entry of node.body) {
          if (
            entry.key.keys[0] &&
            ("name" in entry.key.keys[0]
              ? entry.key.keys[0].name
              : entry.key.keys[0].value) === key
          ) {
            ranges.push(entry.range);
          }
        }
      }
    } else {
      const path = node.key.keys.map((k) => ("name" in k ? k.name : k.value));
      if (path[0] === "mcp_servers" && path.length === 1) {
        throw new CliError(
          "~/.codex/config.toml lists MCP servers inline (mcp_servers = { ... }), which BarnDog can't edit safely, so it was left unchanged. Give each server its own [mcp_servers.<name>] table, then sync again.",
          "barndog sync",
        );
      }

      if (path[0] === "mcp_servers" && path[1] === key) {
        ranges.push(node.range);
      }
    }
  }

  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
    text = text.slice(0, start) + text.slice(end);
  }

  if (value) {
    text =
      text.trimEnd() +
      "\n\n" +
      stringifyToml({ mcp_servers: { [key]: value } });
  }

  parseToml(text);

  return text;
}

/** Modify owned entries only. Unmanaged JSON/TOML text outside those entries is retained. */
export function patchNative(
  text: string | null,
  before: NativeEntry[],
  after: NativeEntry[],
): string {
  const sample = after[0] ?? before[0];
  if (!sample) {
    throw new Error(
      "patchNative needs at least one entry to know which file it edits",
    );
  }

  const toml = sample.file.endsWith(".toml");
  let output =
    text ??
    (sample.harness === "cursor" && sample.kind !== "mcp"
      ? '{\n  "version": 1\n}\n'
      : "{}\n");

  const read = () =>
    toml
      ? object(parseToml(text === null ? "" : output), sample.file)
      : json(output, sample.file);

  let data = read();
  if (toml && text === null) {
    output = "";
  }

  const change = (path: (string | number)[], value: unknown) => {
    const index = path.at(-1);
    if (value === undefined && typeof index === "number") {
      const tree = parseTree(output);
      const parent = tree && findNodeAtLocation(tree, path.slice(0, -1));
      const nodes = parent?.children;
      const node = nodes?.[index];
      if (!parent || !nodes || !node) {
        throw new CliError(
          `${sample.file} changed while BarnDog was editing it. Try again.`,
          "barndog sync",
        );
      }

      const previous = nodes[index - 1];
      const next = nodes[index + 1];

      const start = previous
        ? previous.offset + previous.length
        : node.offset + node.length;

      const end = previous
        ? node.offset
        : (next?.offset ?? parent.offset + parent.length - 1);

      const scanner = createScanner(output.slice(start, end), true);
      let comma = -1;
      while (scanner.scan() !== SyntaxKind.EOF) {
        if (scanner.getToken() === SyntaxKind.CommaToken) {
          comma = start + scanner.getTokenOffset();
          break;
        }
      }

      const edits = [{ offset: node.offset, length: node.length, content: "" }];
      if (comma >= 0) {
        edits.push({ offset: comma, length: 1, content: "" });
      }

      output = applyEdits(output, edits);
    } else {
      output = applyEdits(output, modify(output, path, value, {}));
    }

    data = json(output, sample.file);
  };

  const table = (key: string) =>
    data[key] === undefined ? {} : object(data[key], sample.file);

  /** The handlers registered for one hook event. */
  const list = (event: string): unknown[] => {
    const handlers = table("hooks")[event];

    return Array.isArray(handlers) ? handlers : [];
  };

  for (const old of before) {
    if (old.kind === "mcp") {
      const parent = toml ? "mcp_servers" : "mcpServers";
      if (!same(table(parent)[old.key], old.value)) {
        throw new CliError(
          `The MCP server ${old.key} that BarnDog installed in ${sample.file} was changed by hand. Undo that edit or remove the entry, then sync again.`,
          "barndog sync",
        );
      }
    } else {
      const list = table("hooks")[old.key];
      if (
        !Array.isArray(list) ||
        list.filter((v) => same(v, old.value)).length !== 1
      ) {
        throw new CliError(
          `The ${old.key} Hook that BarnDog installed in ${sample.file} was changed by hand. Undo that edit or remove the entry, then sync again.`,
          "barndog sync",
        );
      }
    }
  }

  // Detect collisions before removing anything, including semantically identical unmanaged registrations.
  for (const next of after) {
    if (next.kind === "mcp") {
      const parent = toml ? "mcp_servers" : "mcpServers";
      if (
        Object.hasOwn(table(parent), next.key) &&
        !before.some((old) => old.kind === "mcp" && old.key === next.key)
      ) {
        throw new CliError(
          `${sample.file} already has an MCP server named ${next.key} that BarnDog didn't add. Remove it, or install BarnDog's under another name.`,
          `barndog mcp rename ${next.key}`,
        );
      }

      if (
        after.filter((e) => e.kind === "mcp" && e.key === next.key).length > 1
      ) {
        throw new CliError(
          `Two MCP servers would both be installed as ${next.key}.`,
          `barndog mcp rename ${next.key}`,
        );
      }
    } else {
      if (
        after.filter(
          (e) =>
            e.kind !== "mcp" && e.key === next.key && same(e.value, next.value),
        ).length > 1
      ) {
        throw new Error(`The same ${next.key} Hook handler was planned twice`);
      }

      const list = table("hooks")[next.key];
      if (list !== undefined && !Array.isArray(list)) {
        throw new CliError(
          `hooks.${next.key} in ${sample.file} isn't a list, so BarnDog left the file unchanged. Fix it, then sync again.`,
          "barndog sync",
        );
      }

      if (
        Array.isArray(list) &&
        list.some((v) => same(v, next.value)) &&
        !before.some(
          (old) => old.key === next.key && same(old.value, next.value),
        )
      ) {
        throw new CliError(
          `${sample.file} already runs this ${next.key} Hook, but BarnDog didn't add it. Remove your copy, then sync again.`,
          "barndog sync",
        );
      }
    }
  }

  for (const old of before) {
    if (
      after.some(
        (next) =>
          next.kind === old.kind &&
          next.key === old.key &&
          next.id === old.id &&
          same(next.value, old.value),
      )
    ) {
      continue;
    }

    if (old.kind === "mcp") {
      if (toml) {
        output = tomlEdit(output, old.key, undefined);
        data = object(parseToml(output), sample.file);
      } else {
        change(["mcpServers", old.key], undefined);
      }
    } else {
      const index = list(old.key).findIndex((v) => same(v, old.value));
      change(["hooks", old.key, index], undefined);
      if (!list(old.key).length) {
        change(["hooks", old.key], undefined);
      }
    }
  }

  for (const next of after) {
    if (
      before.some(
        (old) =>
          old.kind === next.kind &&
          old.key === next.key &&
          old.id === next.id &&
          same(old.value, next.value),
      )
    ) {
      continue;
    }

    if (next.kind === "mcp") {
      if (toml) {
        output = tomlEdit(output, next.key, next.value);
        data = object(parseToml(output), sample.file);
      } else {
        change(["mcpServers", next.key], next.value);
      }
    } else {
      const handlers = table("hooks")[next.key];
      if (Array.isArray(handlers)) {
        change(["hooks", next.key, handlers.length], next.value);
      } else {
        change(["hooks", next.key], [next.value]);
      }
    }
  }

  if (
    !toml &&
    sample.harness === "cursor" &&
    sample.kind !== "mcp" &&
    data.version !== 1
  ) {
    throw new CliError(
      `${sample.file} has a version BarnDog doesn't support (it expects "version": 1), so it was left unchanged.`,
    );
  }

  return output;
}
