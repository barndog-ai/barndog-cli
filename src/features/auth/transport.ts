import { HTTP_STATUS } from "../../shared/constants.js";

import { createApiClient } from "@barndog-ai/api-contract";
import { homedir } from "node:os";
import { readCredentials } from "./credentials.js";
import { CliError } from "../../errors.js";

/** CLI policy: stop an API request after thirty seconds. */
const API_REQUEST_TIMEOUT_MS = 30000;

/**
 * The request never got an HTTP response: DNS, refused connection, TLS, or the
 * thirty-second timeout. Fetch reports these as a `TypeError` or a
 * `TimeoutError`; this names them once, at the one place the CLI calls the API.
 */
class ServerUnreachableError extends CliError {
  constructor(server: string, options?: ErrorOptions) {
    super(
      `Can't reach the BarnDog server at ${server}. Check your connection and that the server is running.`,
      "barndog doctor",
      options,
    );

    this.name = "ServerUnreachableError";
  }
}

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
    throw new CliError(
      `${value} isn't a server address. Use one like https://barndog.dev.`,
    );
  }

  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    throw new CliError(
      `${value} must use https://. Plain http:// works only for localhost.`,
    );
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

    let response: Response;
    try {
      response = await fetch(request, {
        headers,
        redirect: "error",
        signal: AbortSignal.any([
          request.signal,
          AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
        ]),
      });
    } catch (error) {
      // A caller's own abort (such as a cancelled sign-in) stays an abort.
      if (request.signal.aborted) {
        throw error;
      }

      throw new ServerUnreachableError(origin, { cause: error });
    }

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
