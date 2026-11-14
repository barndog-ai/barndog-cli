import { homedir } from "node:os";
import { z } from "zod";
import { ApiError } from "@barndog-ai/api-contract";

import type { Connection } from "../../config/settings.js";
import { serverFetch } from "../auth/transport.js";

/**
 * A caller-chosen idempotency key. Sending the same key again retries the
 * same write instead of repeating it, so keep it until the write is confirmed.
 */
export type RetryKey = string;

/** Sends `FormData` as it is and anything else defined as JSON. */
function requestBody(body: unknown): {
  headers?: HeadersInit;
  body?: BodyInit;
} {
  if (body instanceof FormData) {
    return { body };
  }

  if (body === undefined) {
    return {};
  }

  return {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * Sends an authenticated /v1/ request and validates JSON against the supplied
 * schema; non-success responses throw ApiError.
 */
export async function request<T>(
  conn: Connection,
  path: string,
  schema: z.ZodType<T>,
  {
    home = homedir(),
    method = "GET",
    body,
  }: { home?: string; method?: string; body?: unknown } = {},
): Promise<T> {
  if (!path.startsWith("/v1/") || path.includes("..")) {
    throw new Error("Invalid API path");
  }

  const response = await serverFetch(conn.server, home)(
    `${conn.server}${path}`,
    {
      method,
      ...requestBody(body),
    },
  );

  if (!response.ok) {
    const error = z
      .object({ code: z.string(), message: z.string() })
      .safeParse(await response.json().catch(() => null));

    throw new ApiError(
      response.status,
      error.success ? error.data.code : "REQUEST_FAILED",
      error.success
        ? error.data.message
        : `Request failed (${response.status})`,
    );
  }

  return schema.parse(await response.json());
}
