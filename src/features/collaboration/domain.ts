import { createApiClient, hookManifestSchema } from "@barndog-ai/api-contract";
import {
  packageMetadata,
  type PackageEntry,
} from "@barndog-ai/api-contract/package";
import { parse } from "yaml";
import { serverFetch, normalizeServer } from "../auth/transport.js";
import { homedir } from "node:os";

export type PackageKind = "skill" | "hook";

export function packagePath(path: string, kind: PackageKind) {
  return kind === "skill"
    ? path
    : path
        .replace(/^\/v1\/skills(?=\/|$)/, "/v1/hooks")
        .replace(/^\/v1\/skill-changes(?=\/|$)/, "/v1/hook-changes");
}

function fields(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) return value.map((v) => fields(v, from, to));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [
        key === from
          ? to
          : key === `published${from[0]!.toUpperCase()}${from.slice(1)}`
            ? `published${to[0]!.toUpperCase()}${to.slice(1)}`
            : key,
        fields(val, from, to),
      ]),
    );
  return value;
}

/** Transport adapter for the proven working-copy algorithm. Distinct public Hook
 * contracts and manifests remain separate; legacy Skill field aliases stay local. */
export function collaborationClient(
  server: string,
  home = homedir(),
  kind: PackageKind = "skill",
) {
  const transport = serverFetch(server, home);
  return createApiClient({
    baseUrl: normalizeServer(server),
    fetch: async (input, init) => {
      let request = new Request(input, init);
      if (kind === "hook") {
        const url = new URL(request.url);
        url.pathname = packagePath(url.pathname, kind);
        const headers = new Headers(request.headers);
        let body: BodyInit | undefined;
        if (request.method !== "GET" && request.method !== "HEAD") {
          if (headers.get("content-type")?.includes("multipart/form-data")) {
            const form = await request.formData();
            const metadata = form.get("metadata");
            if (typeof metadata === "string")
              form.set(
                "metadata",
                JSON.stringify(
                  fields(JSON.parse(metadata), "skillId", "hookId"),
                ),
              );
            headers.delete("content-type");
            headers.delete("content-length");
            body = form;
          } else body = await request.text();
        }
        request = new Request(url, {
          method: request.method,
          headers,
          body,
          signal: request.signal,
        });
      }
      const response = await transport(request);
      if (
        kind !== "hook" ||
        !response.headers.get("content-type")?.includes("application/json")
      )
        return response;
      let data = fields(await response.json(), "hookId", "skillId") as Record<
        string,
        unknown
      >;
      if (data && "nextCursor" in data && Array.isArray(data.hooks)) {
        const { hooks, ...rest } = data;
        data = { ...rest, skills: hooks };
      }
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers,
      });
    },
  });
}

export function metadata(entries: PackageEntry[], kind: PackageKind = "skill") {
  if (kind === "skill") return packageMetadata(entries);
  if (!entries.some((e) => e.path === "hook.yaml"))
    throw new Error("MISSING_PACKAGE_MANIFEST: hook.yaml");
  const manifest = hookManifestSchema.parse(
    parse(
      entries.find((e) => e.path === "hook.yaml")?.data.toString("utf8") ?? "",
    ),
  );
  for (const implementation of Object.values(manifest.implementations))
    if (implementation)
      for (const script of implementation.scripts)
        if (!entries.some((e) => e.path === script))
          throw new Error(`Missing Hook script: ${script}`);
  return manifest;
}
