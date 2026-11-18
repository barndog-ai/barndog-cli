import type { RuntimeContext } from "../../runtime.js";
import { POSIX_MODE } from "../../shared/constants.js";
import { readState } from "../../config/state.js";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";

import {
  mcpDefinitionSchema,
  type McpDefinition,
} from "@barndog-ai/api-contract";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { stringify } from "yaml";

import { readSettings, SetupRequiredError } from "../../config/settings.js";
import { CliError } from "../../errors.js";
import {
  adapters,
  harnesses,
  type Harness,
  nativeFile,
} from "../../harnesses/registry.js";
import { locked } from "../environment/transaction.js";
import { fileText, ifExists, writeAtomic } from "../../shared/files.js";
import { synchronize } from "../environment/sync.js";
import { patchNative } from "../native/configuration.js";
import { NAME_RULE } from "../workspace/format.js";
import { validAssetName, VARIABLE_NAME } from "../../shared/patterns.js";
import { LOCAL_ORIGIN } from "../workspace/overlay.js";
import { ensureLocalWorkspace } from "../imports/local.js";
import { asRecord, asStrings, isRecord } from "../../shared/values.js";
import { barndogPaths } from "../../config/paths.js";

/** Random characters that keep two backups of one file taken in the same millisecond apart. */
const BACKUP_SUFFIX_LENGTH = 8;

/**
 * An MCP server entry as a harness or pasted JSON spells it, before conversion.
 */
type RawServer = Record<string, unknown>;

export type ImportedServer = { name: string; server: RawServer };

const isServer = (value: unknown): value is RawServer =>
  isRecord(value) &&
  ("command" in value || "url" in value || "httpUrl" in value);

/** Accepts the shapes people copy: a harness's whole file, a name map, or one server. */
export function parseMcpText(text: string, name?: string): ImportedServer[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new CliError("That isn't valid JSON.", undefined, { cause: error });
  }

  if (isServer(value)) {
    if (!name) {
      throw new CliError(
        "This JSON is one server without a name.",
        "barndog mcp add <name> --file <path>",
      );
    }

    return [{ name, server: value }];
  }

  const object = asRecord(value);
  const map = asRecord(object.mcpServers ?? object.servers ?? object);
  const servers = Object.entries(map).flatMap(([key, server]) =>
    isServer(server) ? [{ key, server }] : [],
  );

  if (!servers.length) {
    throw new CliError(
      "No MCP servers found in that JSON. Each one needs a command or url.",
    );
  }

  if (name && servers.length > 1 && !servers.some(({ key }) => key === name)) {
    throw new CliError(
      `No MCP server named ${name} in that JSON. It has ${servers.map(({ key }) => key).join(", ")}.`,
      "Run it again with one of those names",
    );
  }

  return servers
    .filter(({ key }) => !name || servers.length === 1 || key === name)
    .map(({ key, server }) => ({
      name: servers.length === 1 && name ? name : key,
      server,
    }));
}

/** A braced variable reference, `${API_KEY}` (Claude Code) or `${env:API_KEY}` (Cursor). */
const BRACED_VARIABLE = new RegExp(
  String.raw`\$\{(?:env:)?(${VARIABLE_NAME.source})\}`,
);

/** A whole value that is one variable reference, braced or bare (`$API_KEY`). */
const WHOLE_VARIABLE = new RegExp(
  String.raw`^(?:${BRACED_VARIABLE.source}|\$(${VARIABLE_NAME.source}))$`,
);

/**
 * The variable a whole value refers to: `${env:TOKEN}` or `$TOKEN` → `TOKEN`.
 *
 * @internal Exported for its table test in `src/tests/patterns.test.ts`.
 */
export const variableName = (value: string) => {
  const [, braced, bare] = WHOLE_VARIABLE.exec(value) ?? [];

  return braced ?? bare;
};

/**
 * The first braced variable inside a value: `Bearer ${TOKEN}` → `TOKEN`.
 *
 * @internal Exported for its table test in `src/tests/patterns.test.ts`.
 */
export const embeddedVariable = (value: string) =>
  BRACED_VARIABLE.exec(value)?.[1];

/**
 * An environment variable name made from any text: `my-server_x-api` → `MY_SERVER_X_API`.
 *
 * @internal Exported for its table test in `src/tests/patterns.test.ts`.
 */
export const envName = (text: string) =>
  text.toUpperCase().replace(/[^\dA-Z_]/g, "_");

/** Words that suggest a credential: `--api-key`, `apikey=`, `TOKEN`, `password`. */
const SECRET_WORD = /api[-_]?key|token|secret|password/i;

/**
 * Whether a command-line argument may hold a credential: a secret-sounding word, or an `sk-` key.
 *
 * @internal Exported for its table test in `src/tests/patterns.test.ts`.
 */
export const looksSecret = (arg: string) =>
  SECRET_WORD.test(arg) || arg.startsWith("sk-");

/**
 * An imported server as a BarnDog MCP definition, with what the developer still
 * has to do (such as set an environment variable).
 */
export type ConvertedServer = {
  name: string;
  definition: McpDefinition;
  /** What the developer has to do before it works. */
  notes: string[];
};

/** Secrets are named, never stored: every literal becomes a variable to set locally. */
function reference(
  key: string,
  value: unknown,
  fallback: string,
  notes: string[],
) {
  const text = String(value);
  const whole = variableName(text);
  if (whole) {
    return { secretRef: whole };
  }

  const inside = embeddedVariable(text);
  if (inside) {
    notes.push(
      `${key} mixes text with ${inside}. Set ${inside} to the complete value of ${key}, including that text.`,
    );

    return { secretRef: inside };
  }

  notes.push(
    `${key} held a literal value, which BarnDog doesn't store. Set ${fallback} in your environment.`,
  );

  return { secretRef: fallback };
}

/**
 * Converts environment and header values to local secret references. Command
 * arguments and URLs are preserved, so the result is not guaranteed to be free
 * of secrets.
 */
/** An HTTP server's address, as `url` or Gemini's `httpUrl`; a stdio server has none. */
function serverUrl(name: string, server: RawServer): string | undefined {
  const address = server.url ?? server.httpUrl;
  if (address !== undefined && typeof address !== "string") {
    throw new CliError(
      `${name} can't be added: its url must be text, such as "https://example.com/mcp".`,
    );
  }

  return address;
}

export function convertServer(
  { name, server }: ImportedServer,
  description?: string,
  oauth?: boolean,
): ConvertedServer {
  const notes: string[] = [];
  const type = typeof server.type === "string" ? server.type : undefined;
  if (type === "sse" || type === "ws") {
    throw new CliError(
      `${name} uses ${type} transport. BarnDog supports stdio and HTTP servers.`,
    );
  }

  const url = serverUrl(name, server);
  const common = {
    description:
      description ??
      (typeof server.description === "string" && server.description.trim()
        ? server.description
        : `${name} MCP server`),
  };

  let candidate: unknown;
  if (url) {
    const headers: Record<string, { secretRef: string }> = {};
    for (const [key, value] of Object.entries(
      asRecord(server.headers ?? server.http_headers),
    )) {
      headers[key] = reference(key, value, envName(`${name}_${key}`), notes);
    }

    for (const [key, value] of Object.entries(
      asRecord(server.env_http_headers),
    )) {
      if (typeof value === "string") {
        headers[key] = { secretRef: value };
      }
    }

    if (typeof server.bearer_token_env_var === "string") {
      headers.Authorization = { secretRef: server.bearer_token_env_var };
      notes.push(
        `Set ${server.bearer_token_env_var} to the whole Authorization value, including "Bearer ".`,
      );
    }

    // Claude Code writes `oauth` and Cursor writes `auth` for servers that sign in natively.
    const signsIn = oauth || !!server.oauth || !!server.auth;
    if (signsIn) {
      notes.push(
        `Sign in once it's added: barndog mcp auth ${name} --origin ${LOCAL_ORIGIN} --harness <tool>`,
      );
    }

    candidate = {
      ...common,
      transport: "http",
      url,
      headers,
      authentication: httpAuthentication(signsIn, headers),
    };
  } else {
    if (oauth) {
      throw new CliError(
        `${name} runs as a local command, and only HTTP servers sign in with OAuth.`,
      );
    }

    const environment: Record<string, { secretRef: string }> = {};
    for (const [key, value] of Object.entries(asRecord(server.env))) {
      environment[key] = reference(key, value, key, notes);
    }

    for (const key of asStrings(server.env_vars)) {
      environment[key] = { secretRef: key };
    }

    const listed: unknown[] = Array.isArray(server.args) ? server.args : [];
    const args = listed.map(String);
    if (args.some(looksSecret)) {
      notes.push(
        "An argument looks like it may hold a secret. Arguments are stored as written, so check them before sharing this.",
      );
    }

    candidate = {
      ...common,
      transport: "stdio",
      command: server.command,
      args,
      environment,
      authentication: Object.keys(environment).length ? "environment" : "none",
    };
  }

  const parsed = mcpDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CliError(
      `${name} can't be added: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "server"}: ${issue.message}`).join("; ")}`,
    );
  }

  return { name, definition: parsed.data, notes };
}

export type HarnessServer = ImportedServer & {
  harness: Harness;
  label: string;
  /** The settings file it's configured in. */
  file: string;
  /** The entry as the tool's file spells it; `server` is in Claude Code's shape. */
  native: RawServer;
};

/** How an imported HTTP server authenticates. */
function httpAuthentication(
  signsIn: boolean,
  headers: Record<string, unknown>,
) {
  if (signsIn) {
    return "native-oauth";
  }

  return Object.keys(headers).length ? "environment" : "none";
}

async function jsonFile(path: string) {
  const text = await fileText(path).catch(() => null);

  return text ? asRecord(parseJsonc(text)) : {};
}

/** Servers each harness has configured, leaving out the ones BarnDog installed. */
export async function harnessServers(
  runtime: RuntimeContext,
): Promise<HarnessServer[]> {
  const { home } = runtime;

  const { native } = await readState(home);
  const owned = new Set(
    native
      .filter((entry) => entry.kind === "mcp")
      .map((entry) => `${entry.file}:${entry.key}`),
  );

  const found: HarnessServer[] = [];
  const add = (
    harness: Harness,
    source: { label: string; file: string },
    servers: unknown,
  ) => {
    const { imported } = adapters[harness].mcp;

    for (const [name, entry] of Object.entries(asRecord(servers))) {
      if (!isRecord(entry) || owned.has(`${source.file}:${name}`)) {
        continue;
      }

      const server = imported ? imported(entry) : entry;
      if (isServer(server)) {
        found.push({ harness, ...source, name, server, native: entry });
      }
    }
  };

  const claudeFile = nativeFile("claude", "mcp", home);
  const claude = await jsonFile(claudeFile);
  add(
    "claude",
    { label: adapters.claude.name, file: claudeFile },
    claude.mcpServers,
  );

  for (const [project, value] of Object.entries(asRecord(claude.projects))) {
    add(
      "claude",
      {
        label: `${adapters.claude.name}, ${basename(project)} project`,
        file: claudeFile,
      },
      asRecord(value).mcpServers,
    );
  }

  const cursorFile = nativeFile("cursor", "mcp", home);
  add(
    "cursor",
    { label: adapters.cursor.name, file: cursorFile },
    (await jsonFile(cursorFile)).mcpServers,
  );

  const codexFile = nativeFile("codex", "mcp", home);
  const codex = await fileText(codexFile).catch(() => null);
  if (codex) {
    let settings;
    try {
      settings = parseToml(codex);
    } catch (error) {
      throw new CliError(
        `${codexFile} isn't valid TOML, so BarnDog can't read the MCP servers in it.`,
        `Fix ${codexFile}, then try again`,
        { cause: error },
      );
    }

    add(
      "codex",
      { label: adapters.codex.name, file: codexFile },
      settings.mcp_servers,
    );
  }

  const { mcp } = adapters.opencode;
  for (const relative of mcp.files) {
    const file = join(home, relative);
    add(
      "opencode",
      { label: `${adapters.opencode.name}, ${basename(file)}`, file },
      mcp.path.reduce<unknown>(
        (value, key) => asRecord(value)[key],
        await jsonFile(file),
      ),
    );
  }

  return found;
}

/** Native entries BarnDog doesn't own that would block installing this name. */
export async function conflictingEntries(
  name: string,
  runtime: RuntimeContext,
) {
  const { home } = runtime;

  const settings = await readSettings(home);
  if (!settings) {
    throw new SetupRequiredError();
  }

  const servers = await harnessServers(runtime);
  const selected = harnesses.filter((h) => settings.harnesses.includes(h));

  return servers
    .filter(
      (entry) =>
        entry.name === name &&
        selected.includes(entry.harness) &&
        !entry.label.includes("project"),
    )
    .map((entry) => ({
      harness: entry.harness,
      file: entry.file,
      server: entry.native,
    }));
}

/**
 * Writes converted MCP servers and synchronizes them. Existing local workspace
 * names are always rejected; replace permits backing up and removing
 * conflicting native entries.
 */
export async function addMcpServers(
  servers: ConvertedServer[],
  options: { replace?: boolean },
  runtime: RuntimeContext,
) {
  const { home } = runtime;

  const invalid = servers.filter(({ name }) => !validAssetName(name));
  if (invalid.length) {
    throw new CliError(
      `${invalid.map(({ name }) => name).join(", ")} can't be used as ${invalid.length === 1 ? "an MCP name" : "MCP names"}. ${NAME_RULE}. To add one, save only that server to a JSON file under a new name.`,
      "barndog mcp add <new-name> --file <path>",
    );
  }

  return locked(runtime, async () => {
    const workspace = await ensureLocalWorkspace(runtime);
    for (const { name } of servers) {
      const target = join(workspace.path, "org/mcp", `${name}.yaml`);
      if ((await ifExists(lstat(target))) !== null) {
        throw new CliError(
          `A local MCP server named ${name} already exists.`,
          `barndog mcp add ${name}-2 --file <path>`,
        );
      }

      const conflicts = await conflictingEntries(name, runtime);
      if (conflicts.length && !options.replace) {
        throw new CliError(
          `${name} is already configured in ${conflicts.map((c) => c.file).join(" and ")}. Replacing it is required for BarnDog to manage it.`,
          `barndog mcp add ${name} --replace`,
        );
      }
    }

    // One backup per settings file, taken before its first change, so a file
    // that holds several of the servers is backed up as the user left it.
    const backedUp = new Set<string>();
    const backups: string[] = [];
    for (const { name, definition } of servers) {
      for (const conflict of await conflictingEntries(name, runtime)) {
        const text = await readFile(conflict.file, "utf8");
        if (!backedUp.has(conflict.file)) {
          const backup = join(
            barndogPaths(home).migrations,
            `${basename(conflict.file)}-${Date.now()}-${randomUUID().slice(0, BACKUP_SUFFIX_LENGTH)}.bak`,
          );

          await writeAtomic(backup, text);
          backedUp.add(conflict.file);
          backups.push(backup);
        }

        await writeAtomic(
          conflict.file,
          patchNative(
            text,
            [
              {
                id: "import",
                kind: "mcp",
                harness: conflict.harness,
                file: conflict.file,
                key: name,
                value: conflict.server,
              },
            ],
            [],
          ),
        );
      }

      // The workspace's own folders keep default permissions; writeAtomic would make them private.
      await mkdir(join(workspace.path, "org/mcp"), { recursive: true });
      await writeAtomic(
        join(workspace.path, "org/mcp", `${name}.yaml`),
        stringify(definition),
        { mode: POSIX_MODE.regularFile },
      );
    }

    const events = await synchronize(undefined, runtime, undefined, {
      prompt: false,
    });

    return {
      added: servers.map((s) => s.name),
      notes: servers.flatMap((s) => s.notes),
      backups,
      events,
    };
  });
}
