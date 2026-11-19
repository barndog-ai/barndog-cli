/**
 * MCP values BarnDog keeps (`~/.barndog/secrets.json`) are written into the
 * coding tools' settings, so `state.json` would copy them when it records
 * BarnDog's entries. It records a marker instead: the variable's name and a
 * SHA-256 of the value. Comparing a recorded entry with one in a settings file
 * hashes the file's value at each marker, so hand edits are still noticed.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { isRecord } from "../../shared/values.js";

/** A kept value written into an entry, and the variable it belongs to. */
export type SecretUse = { variable: string; value: string };

const PREFIX = "barndog-secret:";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const marker = (secret: SecretUse) =>
  `${PREFIX}${secret.variable}:sha256:${digest(secret.value)}`;

/** The variable and hash in a marker; null for any other text. */
function parseMarker(text: string) {
  if (!text.startsWith(PREFIX)) {
    return null;
  }

  const [variable, , hash] = text.slice(PREFIX.length).split(":");

  return variable && hash ? { variable, hash } : null;
}

/** `value` with every kept value in it replaced by its marker. */
export function redacted(
  value: Record<string, unknown>,
  secrets: readonly SecretUse[],
): Record<string, unknown> {
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") {
      const secret = secrets.find((s) => s.value === item);

      return secret ? marker(secret) : item;
    }

    if (Array.isArray(item)) {
      return item.map(walk);
    }

    if (isRecord(item)) {
      return Object.fromEntries(
        Object.entries(item).map(([key, inner]) => [key, walk(inner)]),
      );
    }

    return item;
  };

  const result = walk(value);

  return isRecord(result) ? result : value;
}

/** Deep equality where a marker on either side equals the value it hashes. */
export function sameValue(left: unknown, right: unknown): boolean {
  if (typeof left === "string" && typeof right === "string") {
    const l = parseMarker(left);
    const r = parseMarker(right);
    if (l && r) {
      return l.hash === r.hash;
    }

    if (l || r) {
      return l ? digest(right) === l.hash : digest(left) === r?.hash;
    }

    return left === right;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => sameValue(item, right[index]))
    );
  }

  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);

    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => key in right && sameValue(left[key], right[key]))
    );
  }

  return isDeepStrictEqual(left, right);
}

/** The variables whose kept values a recorded entry holds. */
export function recordedVariables(value: unknown): string[] {
  if (typeof value === "string") {
    const parsed = parseMarker(value);

    return parsed ? [parsed.variable] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(recordedVariables);
  }

  return isRecord(value) ? Object.values(value).flatMap(recordedVariables) : [];
}
