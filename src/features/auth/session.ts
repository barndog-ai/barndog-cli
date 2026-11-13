import { hasRemoteSelections } from "../../config/environment.js";
import { homedir } from "node:os";
import { setTimeout } from "node:timers/promises";
import {
  createApiClient,
  contextSchema,
  loginPollSchema,
  loginStartSchema,
} from "@barndog-ai/api-contract";
import { readSettings } from "../../config/settings.js";
import { readCredentials, updateCredentials } from "./credentials.js";
import {
  LoginRequiredError,
  normalizeServer,
  serverFetch,
} from "./transport.js";

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

export async function authStatus(home = homedir(), explicitServer?: string) {
  let server;
  try {
    server = await selectedServer(explicitServer, home);
  } catch {
    throw new LoginRequiredError();
  }

  const client = createApiClient({
    baseUrl: server,
    fetch: serverFetch(server, home),
  });

  const context = contextSchema.parse((await client.GET("/v1/context")).data);

  return { server, context };
}
