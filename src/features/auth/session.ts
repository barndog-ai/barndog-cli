import { hasRemoteSelections } from "../../config/environment.js";
import { homedir } from "node:os";
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
  normalizeServer,
  serverFetch,
} from "./transport.js";

/**
 * Device-login inputs, including the caller callback that presents verification
 * details before polling.
 */
export type LoginOptions = {
  server?: string;
  home?: string;
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
  home = homedir(),
): Promise<string | undefined> {
  const settings = await readSettings(home);
  const credentials = await readCredentials(home);
  const value = settings?.connection?.server ?? credentials.selectedServer;

  return value ? normalizeServer(value) : undefined;
}

async function selectedServer(server: string | undefined, home: string) {
  const value = server ?? (await configuredServer(home));
  if (!value) {
    throw new Error(
      "Specify the server for your first login with barndog login --server <url>",
    );
  }

  return normalizeServer(value);
}

/**
 * Starts device login, invokes the verification callback, polls completion and
 * persists the returned session.
 */
export async function login(options: LoginOptions) {
  const home = options.home ?? homedir();
  const server = await selectedServer(options.server, home);
  const client = createApiClient({
    baseUrl: server,
    fetch: serverFetch(server, home, false),
  });

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
    await setTimeout(interval * 1000, undefined, { signal });
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

    const revoke = () =>
      fetch(`${server}/v1/auth/cli/session`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${result.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });

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
        throw new Error(
          "Remove API selections before switching server, organization, or developer",
        );
      }

      await updateCredentials(home, (credentials) => {
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
export async function logout(home = homedir()) {
  const server = await selectedServer(undefined, home);
  const credential = (await readCredentials(home)).servers[server];
  let revoked = true;
  if (credential) {
    try {
      const response = await fetch(`${server}/v1/auth/cli/session`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${credential.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });

      revoked = response.ok;
    } catch {
      revoked = false;
    }
  }

  await updateCredentials(home, (credentials) => {
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
  home = homedir(),
  explicitServer?: string,
): Promise<AuthStatus> {
  let server;
  try {
    server = await selectedServer(explicitServer, home);
  } catch {
    throw new LoginRequiredError();
  }

  const context = contextSchema.parse(
    (await apiClient(server, home).GET("/v1/context")).data,
  );

  return { server, context };
}

/**
 * The organization and developer the saved credential signs in as on `server`;
 * one request to the server.
 */
export async function connectionContext(
  server: string,
  home = homedir(),
): Promise<Connection> {
  server = normalizeServer(server);
  const context = contextSchema.parse(
    (await apiClient(server, home).GET("/v1/context")).data,
  );

  return {
    server,
    organizationId: context.organization.id,
    developerId: context.developer.id,
  };
}
