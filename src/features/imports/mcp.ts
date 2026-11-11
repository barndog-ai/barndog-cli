import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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
import { harnesses, type Harness } from "../../harnesses/registry.js";
import { atomicFile, fileText, locked } from "../environment/transaction.js";
import { synchronize } from "../environment/sync.js";
import { nativeFile, patchNative } from "../native/configuration.js";
import { NAME_RULE, validAssetName } from "../git-workspace/format.js";
import { LOCAL_ORIGIN } from "../git-workspace/overlay.js";
import { ensureLocalWorkspace } from "./local.js";

export type RawServer = Record<string, unknown>;

export type ImportedServer = { name: string; server: RawServer };

const isServer = (value: unknown): value is RawServer =>
  !!value &&
  typeof value === "object" &&
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
    if (!name)
      throw new CliError(
        "This JSON is one server without a name.",
        "barndog mcp add <name> --file <path>",
      );
    return [{ name, server: value }];
  }
  const object = value as Record<string, unknown>;
  const map = (object?.mcpServers ?? object?.servers ?? object) as Record<
    string,
    unknown
  >;
  const servers = Object.entries(map ?? {}).filter(([, server]) =>
    isServer(server),
  );
  if (!servers.length)
    throw new CliError(
      "No MCP servers found in that JSON. Each one needs a command or url.",
    );
  return servers
    .filter(([key]) => !name || servers.length === 1 || key === name)
    .map(([key, server]) => ({
      name: servers.length === 1 && name ? name : key,
      server: server as RawServer,
    }));
}

const variable = (value: string) =>
  /^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(
    value,
  );

const embedded = (value: string) =>
  /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/.exec(value)?.[1];

const envName = (text: string) =>
  text.toUpperCase().replace(/[^A-Z0-9_]/g, "_");

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
  const whole = variable(text);
  if (whole) return { secretRef: whole[1] ?? whole[2]! };
  const inside = embedded(text);
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

export function convertServer(
  { name, server }: ImportedServer,
  description?: string,
  oauth?: boolean,
): ConvertedServer {
  const notes: string[] = [];
  const type = typeof server.type === "string" ? server.type : undefined;
  if (type === "sse" || type === "ws")
    throw new CliError(
      `${name} uses ${type} transport. BarnDog supports stdio and HTTP servers.`,
    );
  const url = (server.url ?? server.httpUrl) as string | undefined;
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
      (server.headers ?? server.http_headers ?? {}) as Record<string, unknown>,
    ))
      headers[key] = reference(key, value, envName(`${name}_${key}`), notes);
    for (const [key, value] of Object.entries(
      (server.env_http_headers ?? {}) as Record<string, string>,
    ))
      headers[key] = { secretRef: value };
    if (typeof server.bearer_token_env_var === "string") {
      headers.Authorization = { secretRef: server.bearer_token_env_var };
      notes.push(
        `Set ${server.bearer_token_env_var} to the whole Authorization value, including "Bearer ".`,
      );
    }
    // Claude Code writes `oauth` and Cursor writes `auth` for servers that sign in natively.
    const signsIn = oauth || !!server.oauth || !!server.auth;
    if (signsIn)
      notes.push(
        `Sign in once it's added: barndog mcp auth ${name} --origin ${LOCAL_ORIGIN} --harness <tool>`,
      );
    candidate = {
      ...common,
      transport: "http",
      url,
      headers,
      authentication: signsIn
        ? "native-oauth"
        : Object.keys(headers).length
          ? "environment"
          : "none",
    };
  } else {
    if (oauth)
      throw new CliError(
        `${name} runs as a local command, and only HTTP servers sign in with OAuth.`,
      );
    const environment: Record<string, { secretRef: string }> = {};
    for (const [key, value] of Object.entries(
      (server.env ?? {}) as Record<string, unknown>,
    ))
      environment[key] = reference(key, value, key, notes);
    for (const key of (server.env_vars ?? []) as string[])
      environment[key] = { secretRef: key };
    const args = ((server.args ?? []) as unknown[]).map(String);
    if (
      args.some(
        (arg) =>
          /(api[-_]?key|token|secret|password)/i.test(arg) || /^sk-/.test(arg),
      )
    )
      notes.push(
        "An argument looks like it may hold a secret. Arguments are stored as written, so check them before sharing this.",
      );
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
  if (!parsed.success)
    throw new CliError(
      `${name} can't be added: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "server"}: ${issue.message}`).join("; ")}`,
    );
  return { name, definition: parsed.data, notes };
}

export type HarnessServer = ImportedServer & {
  harness: Harness;
  label: string;
};

async function jsonFile(path: string) {
  const text = await fileText(path).catch(() => null);
  return text ? ((parseJsonc(text) ?? {}) as Record<string, unknown>) : {};
}

/** Servers each harness has configured, leaving out the ones BarnDog installed. */
export async function harnessServers(
  home = homedir(),
): Promise<HarnessServer[]> {
  const state = await jsonFile(join(home, ".barndog/state.json"));
  const owned = new Set(
    ((state.native ?? []) as { kind: string; harness: string; key: string }[])
      .filter((entry) => entry.kind === "mcp")
      .map((entry) => `${entry.harness}:${entry.key}`),
  );
  const found: HarnessServer[] = [];
  const add = (harness: Harness, label: string, servers: unknown) => {
    for (const [name, server] of Object.entries(
      (servers ?? {}) as Record<string, unknown>,
    ))
      if (isServer(server) && !owned.has(`${harness}:${name}`))
        found.push({ harness, label, name, server });
  };
  const claude = await jsonFile(nativeFile("claude", "mcp", home));
  add("claude", "Claude Code", claude.mcpServers);
  for (const [project, value] of Object.entries(
    (claude.projects ?? {}) as Record<string, { mcpServers?: unknown }>,
  ))
    add(
      "claude",
      `Claude Code, ${basename(project)} project`,
      value?.mcpServers,
    );
  add(
    "cursor",
    "Cursor",
    (await jsonFile(nativeFile("cursor", "mcp", home))).mcpServers,
  );
  const codex = await fileText(nativeFile("codex", "mcp", home)).catch(
    () => null,
  );
  if (codex)
    add(
      "codex",
      "Codex",
      (parseToml(codex) as Record<string, unknown>).mcp_servers,
    );
  return found;
}

/** Native entries BarnDog doesn't own that would block installing this name. */
export async function conflictingEntries(name: string, home = homedir()) {
  const settings = await readSettings(home);
  if (!settings) throw new SetupRequiredError();
  const servers = await harnessServers(home);
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
      file: nativeFile(entry.harness, "mcp", home),
      server: entry.server,
    }));
}

export async function addMcpServers(
  servers: ConvertedServer[],
  options: { replace?: boolean },
  home = homedir(),
) {
  const invalid = servers.filter(({ name }) => !validAssetName(name));
  if (invalid.length)
    throw new CliError(
      `${invalid.map(({ name }) => name).join(", ")} can't be used as ${invalid.length === 1 ? "an MCP name" : "MCP names"}. ${NAME_RULE}. To add one, save only that server to a JSON file under a new name.`,
      "barndog mcp add <new-name> --file <path>",
    );
  return locked(home, async () => {
    const workspace = await ensureLocalWorkspace(home);
    for (const { name } of servers) {
      const target = join(workspace.path, "org/mcp", `${name}.yaml`);
      if (await fileText(target).catch(() => null))
        throw new CliError(
          `A local MCP server named ${name} already exists.`,
          `barndog mcp add ${name}-2 --file <path>`,
        );
      const conflicts = await conflictingEntries(name, home);
      if (conflicts.length && !options.replace)
        throw new CliError(
          `${name} is already configured in ${conflicts.map((c) => c.file).join(" and ")}. Replacing it is required for BarnDog to manage it.`,
          `barndog mcp add ${name} --replace`,
        );
    }
    const backups: string[] = [];
    for (const { name, definition } of servers) {
      for (const conflict of await conflictingEntries(name, home)) {
        const text = await readFile(conflict.file, "utf8");
        const backup = join(
          home,
          ".barndog/migrations",
          `${basename(conflict.file)}-${Date.now()}.bak`,
        );
        await mkdir(join(home, ".barndog/migrations"), {
          recursive: true,
          mode: 0o700,
        });
        await copyFile(conflict.file, backup);
        backups.push(backup);
        await atomicFile(
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
      await mkdir(join(workspace.path, "org/mcp"), { recursive: true });
      await writeFile(
        join(workspace.path, "org/mcp", `${name}.yaml`),
        stringify(definition),
      );
    }
    const events = await synchronize(undefined, home, undefined, {
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
