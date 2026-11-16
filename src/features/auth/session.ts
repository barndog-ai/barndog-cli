import type { RuntimeContext } from "../../runtime.js";
import { MILLISECONDS_PER_SECOND } from "../../shared/constants.js";

import { hasRemoteSelections } from "../../config/environment.js";
import { setTimeout } from "node:timers/promises";
import {
  createApiClient,
  contextSchema,
  loginPollSchema,
  loginStartSchema,
  type ActorContext,
} from "@barndog-ai/api-contract";
import { readSettings, type Connection } from "../../config/settings.js";
import { readCredentials, updateCredentials } from "./credentials.js";
import {
  apiClient,
  LoginRequiredError,
  type ApiClient,
  normalizeServer,
  serverFetch,
} from "./transport.js";
import { CliError } from "../../errors.js";

/** Bound each device authorization request to ten seconds. */
const AUTH_REQUEST_TIMEOUT_MS = 10000;

/**
 * Device-login inputs, including the caller callback that presents verification
 * details before polling.
 */
export type LoginOptions = {
  server?: string;
  runtime: RuntimeContext;
  signal?: AbortSignal;
  verification: (details: {
    userCode: string;
    url: string;
    browserUrl: string;
  }) => Promise<void>;
};

/**
 * The saved connection's server, else the server last signed in to, as a
 * validated origin.
 */
export async function configuredServer(
  runtime: RuntimeContext,
): Promise<string | undefined> {
  const { home } = runtime;

  const settings = await readSettings(home);
  const credentials = await readCredentials(runtime);
  const value = settings?.connection?.server ?? credentials.selectedServer;

  return value ? normalizeServer(value) : undefined;
}

async function selectedServer(
  server: string | undefined,
  runtime: RuntimeContext,
) {
  const value = server ?? (await configuredServer(runtime));
  if (!value) {
    throw new CliError(
      "Choose a server for your first sign-in.",
      "barndog login --server <url>",
    );
  }

  return normalizeServer(value);
}

/**
 * A client that attaches no saved credential: sign-in has none yet, and
 * revoking names the token itself, which may not be the saved one.
 */
const signInClient = (server: string, runtime: RuntimeContext): ApiClient => {
  return createApiClient({
    baseUrl: server,
    fetch: serverFetch(server, runtime, false),
  });
};

/** Ends the session `token` belongs to; throws when the server didn't confirm it. */
async function revokeSession(client: ApiClient, token: string) {
  await client.DELETE("/v1/auth/cli/session", {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
  });
}

/**
 * Starts device login, invokes the verification callback, polls completion and
 * persists the returned session.
 */
export async function login(options: LoginOptions) {
  const { runtime } = options;
  const { home } = runtime;
  const server = await selectedServer(options.server, options.runtime);
  const client = signInClient(server, options.runtime);

  const started = loginStartSchema.parse(
    (await client.POST("/v1/auth/cli/start", { signal: options.signal })).data,
  );

  await options.verification({
    userCode: started.userCode,
    url: started.verificationUri,
    browserUrl: started.verificationUriComplete,
  });

  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(
      Math.max(1, Date.parse(started.expiresAt) - Date.now()),
    ),
  ]);

  let interval = started.interval;
  while (true) {
    await setTimeout(interval * MILLISECONDS_PER_SECOND, undefined, { signal });
    const result = loginPollSchema.parse(
      (
        await client.POST("/v1/auth/cli/poll", {
          body: { pollingToken: started.pollingToken },
          signal,
        })
      ).data,
    );

    if (result.status !== "complete") {
      interval = result.interval;
      continue;
    }

    const revoke = () => revokeSession(client, result.token);

    try {
      const settings = await readSettings(home);
      if (
        settings &&
        hasRemoteSelections(settings) &&
        settings.connection &&
        (settings.connection.server !== server ||
          settings.connection.organizationId !==
            result.context.organization.id ||
          settings.connection.developerId !== result.context.developer.id)
      ) {
        throw new CliError(
          "You have assets selected from the current server. Remove them before switching server, organization or developer.",
          "barndog status",
        );
      }

      await updateCredentials(options.runtime, (credentials) => {
        credentials.servers[server] = {
          token: result.token,
          expiresAt: result.expiresAt,
          context: result.context,
        };

        credentials.selectedServer = server;
      });
    } catch (error) {
      await revoke().catch(() => {});
      throw error;
    }

    return { server, context: result.context, expiresAt: result.expiresAt };
  }
}

/**
 * Attempts remote session revocation and removes local credentials even if
 * revocation fails; reports that outcome.
 */
export async function logout(runtime: RuntimeContext) {
  const server = await selectedServer(undefined, runtime);
  const credential = (await readCredentials(runtime)).servers[server];
  let revoked = true;
  if (credential) {
    try {
      await revokeSession(signInClient(server, runtime), credential.token);
    } catch {
      revoked = false;
    }
  }

  await updateCredentials(runtime, (credentials) => {
    delete credentials.servers[server];
    if (credentials.selectedServer === server) {
      delete credentials.selectedServer;
    }
  });

  return { server, revoked };
}

/** Who this machine is signed in as, and on which server. */
export type AuthStatus = { server: string; context: ActorContext };

/**
 * Fetches the authenticated server context; missing or expired credentials
 * require login.
 */
export async function authStatus(
  runtime: RuntimeContext,
  explicitServer?: string,
): Promise<AuthStatus> {
  let server;
  try {
    server = await selectedServer(explicitServer, runtime);
  } catch {
    throw new LoginRequiredError();
  }

  const context = contextSchema.parse(
    (await apiClient(server, runtime).GET("/v1/context")).data,
  );

  return { server, context };
}

/**
 * The organization and developer the saved credential signs in as on `server`;
 * one request to the server.
 */
export async function connectionContext(
  server: string,
  runtime: RuntimeContext,
): Promise<Connection> {
  server = normalizeServer(server);
  const context = contextSchema.parse(
    (await apiClient(server, runtime).GET("/v1/context")).data,
  );

  return {
    server,
    organizationId: context.organization.id,
    developerId: context.developer.id,
  };
}
