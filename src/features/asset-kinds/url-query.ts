/**
 * MCP server URLs with a query string. Hosted servers put their settings there
 * (Supabase's `?project_ref=…&read_only=true`), but some take an API key the
 * same way, and BarnDog stores a URL as written. So the developer is warned
 * before adding one, and asked again before sharing it beyond this machine.
 */
import type { McpDefinition } from "@barndog-ai/api-contract";

/** An MCP server whose URL has a query string, and that string's parameter names. */
export type UrlQuery = { name: string; parameters: string[] };

/**
 * Asked before an MCP server whose URL has a query string is shared beyond this
 * machine; false leaves everything as it was.
 */
export type ConfirmUrlQuery = (servers: UrlQuery[]) => Promise<boolean>;

/**
 * The names of an HTTP server's query parameters, never their values, which may
 * be secret. Empty for a stdio server or a URL without a query string.
 */
export function queryParameters(definition: McpDefinition): string[] {
  if (definition.transport !== "http") {
    return [];
  }

  return [...new Set(new URL(definition.url).searchParams.keys())];
}

/**
 * Whether to share the servers whose URLs have a query string: true when there
 * are none, else what `confirm` answers. Without `confirm`, nobody was asked,
 * so they are not shared.
 */
export async function mayShareUrlQueries(
  servers: readonly { name: string; definition?: McpDefinition }[],
  confirm: ConfirmUrlQuery | undefined,
): Promise<boolean> {
  const queries = urlQueries(servers);

  return !queries.length || ((await confirm?.(queries)) ?? false);
}

/** The servers among `servers` whose URLs have a query string. */
export function urlQueries(
  servers: readonly { name: string; definition?: McpDefinition }[],
): UrlQuery[] {
  return servers.flatMap(({ name, definition }) => {
    const parameters = definition ? queryParameters(definition) : [];

    return parameters.length ? [{ name, parameters }] : [];
  });
}
