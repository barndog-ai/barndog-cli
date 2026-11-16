import type { RuntimeContext } from "../../runtime.js";
import { HTTP_STATUS } from "../../shared/constants.js";

import { readFile } from "node:fs/promises";

import {
  ApiError,
  environmentCatalogRevisionSchema,
} from "@barndog-ai/api-contract";
import { z } from "zod";

import { readSettings, type Connection } from "../../config/settings.js";
import { parsed } from "../server/client.js";
import { writeAtomic } from "../../shared/files.js";
import { barndogPaths } from "../../config/paths.js";
import { apiClient } from "../auth/transport.js";

/** Background refresh policy: check at most every five minutes (milliseconds). */
const CHECK_INTERVAL_MS = 300000;

const checkSchema = z.object({
  server: z.string(),
  organizationId: z.string(),
  developerId: z.string(),
  checkedAt: z.string(),
  /** The catalog revision the last successful sync delivered. */
  revision: z.string().optional(),
});

type Check = z.infer<typeof checkSchema>;

async function readCheck(runtime: RuntimeContext, conn: Connection) {
  const { home } = runtime;

  const text = await readFile(barndogPaths(home).cloudCheck, "utf8").catch(
    () => null,
  );

  if (!text) {
    return undefined;
  }

  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }

  const check = checkSchema.safeParse(value);

  return check.success &&
    check.data.server === conn.server &&
    check.data.organizationId === conn.organizationId &&
    check.data.developerId === conn.developerId
    ? check.data
    : undefined;
}

async function writeCheck(runtime: RuntimeContext, check: Check) {
  const { home } = runtime;

  await writeAtomic(
    barndogPaths(home).cloudCheck,
    `${JSON.stringify(check)}\n`,
  );
}

/** A server from before the check existed answers 404; sync as if it changed. */
async function currentRevision(conn: Connection, runtime: RuntimeContext) {
  try {
    const { revision } = await parsed(
      environmentCatalogRevisionSchema,
      apiClient(conn.server, runtime).GET("/v1/environment/catalog/revision"),
    );

    return revision;
  } catch (error) {
    if (error instanceof ApiError && error.status === HTTP_STATUS.notFound) {
      return undefined;
    }

    throw error;
  }
}

/**
 * Runs the session-start sync, asking a cloud workspace whether anything
 * changed before doing the work. Git and local workspaces have their own fetch
 * limit. A local folder beside cloud can change at any time, so it always syncs.
 */
export async function autoSync(
  sync: () => Promise<unknown>,
  runtime: RuntimeContext,
): Promise<void> {
  const { home } = runtime;

  const settings = await readSettings(home);

  if (!settings || !settings.connection || settings.localWorkspace) {
    await sync();

    return;
  }

  const conn = settings.connection;
  const previous = await readCheck(runtime, conn);

  if (
    previous &&
    Date.now() - Date.parse(previous.checkedAt) < CHECK_INTERVAL_MS
  ) {
    return;
  }

  const record = (revision: string | undefined) =>
    writeCheck(runtime, {
      server: conn.server,
      organizationId: conn.organizationId,
      developerId: conn.developerId,
      checkedAt: new Date().toISOString(),
      revision,
    });

  try {
    const revision = await currentRevision(conn, runtime);

    if (revision !== undefined && revision === previous?.revision) {
      await record(revision);

      return;
    }

    await sync();
    await record(revision);
  } catch (error) {
    // Keeps the limit while offline or signed out, and retries the same change.
    await record(previous?.revision);
    throw error;
  }
}
