import { HTTP_STATUS } from "../../shared/constants.js";

import { createApiClient } from "@barndog-ai/api-contract";
import { homedir } from "node:os";
import { readCredentials } from "./credentials.js";

/** CLI policy: stop an API request after thirty seconds. */
const API_REQUEST_TIMEOUT_MS = 30000;

export class LoginRequiredError extends Error {
  constructor() {
    super("Authentication required. Run barndog login.");
  }
}

/**
 * Validates a bare HTTP(S) origin; HTTP is allowed only on loopback, and
 * credentials or URL suffixes are rejected.
 */
export function normalizeServer(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("Server must be an HTTP(S) origin");
  }

  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("Server must use HTTPS outside loopback");
  }

  return url.origin;
}

/**
 * Creates an origin-bound fetch with optional saved credentials, redirect
 * rejection and a 30-second request timeout.
 */
export function serverFetch(
  server: string,
  home = homedir(),
  authenticated = true,
): typeof fetch {
  const origin = normalizeServer(server);

  return async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== origin) {
      throw new Error("Refusing to send credentials to another server");
    }

    const headers = new Headers(request.headers);
    if (authenticated) {
      const credential = (await readCredentials(home)).servers[origin];
      if (!credential || Date.parse(credential.expiresAt) <= Date.now()) {
        throw new LoginRequiredError();
      }

      headers.set("Authorization", `Bearer ${credential.token}`);
    }

    const response = await fetch(request, {
      headers,
      redirect: "error",
      signal: AbortSignal.any([
        request.signal,
        AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
      ]),
    });

    if (response.status === HTTP_STATUS.unauthorized && authenticated) {
      throw new LoginRequiredError();
    }

    return response;
  };
}

/**
 * A typed client for the BarnDog API that sends the saved credential for
 * `server`, refusing redirects and requests to other origins.
 */
export function apiClient(server: string, home = homedir()) {
  return createApiClient({
    baseUrl: normalizeServer(server),
    fetch: serverFetch(server, home),
  });
}
