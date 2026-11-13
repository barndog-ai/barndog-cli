import { homedir } from "node:os";
import { readCredentials } from "./credentials.js";

export class LoginRequiredError extends Error {
  constructor() {
    super("Authentication required. Run barndog login.");
  }
}

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
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(30000)]),
    });

    if (response.status === 401 && authenticated) {
      throw new LoginRequiredError();
    }

    return response;
  };
}
