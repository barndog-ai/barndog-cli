import type { z } from "zod";

import { defined } from "../../shared/lookup.js";

/**
 * A caller-chosen idempotency key. Sending the same key again retries the
 * same write instead of repeating it, so keep it until the write is confirmed.
 */
export type RetryKey = string;

/** The body of a successful response; the client throws ApiError for failures. */
export function responseData<T>(response: { data?: T }): T {
  return defined(response.data, "The server sent an empty response");
}

/**
 * Awaits a typed-client call and validates its body. The client's types come
 * from the server's OpenAPI document and check the request; the schema checks
 * what this server actually sent.
 */
export async function parsed<T>(
  schema: z.ZodType<T>,
  call: Promise<{ data?: unknown }>,
): Promise<T> {
  return schema.parse(responseData(await call));
}
