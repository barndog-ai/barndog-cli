import { createApiClient, hookManifestSchema } from "@barndog-ai/api-contract";
import {
  packageMetadata,
  type PackageEntry,
} from "@barndog-ai/api-contract/package";
import { parse } from "yaml";
import { serverFetch, normalizeServer } from "../auth/transport.js";
import { homedir } from "node:os";
import { assetKinds, type PackageKind } from "../asset-kinds/index.js";
import { defined } from "../../shared/lookup.js";

/** The typed client speaks Skill routes; other package kinds swap in their own. */
export function packagePath(path: string, kind: PackageKind) {
  return path
    .replace(/^\/v1\/skills(?=\/|$)/, `/v1/${assetKinds[kind].route}`)
    .replace(/^\/v1\/skill-changes(?=\/|$)/, `/v1/${kind}-changes`);
}

const capitalized = (word: string) =>
  `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

/** Renames `from` to `to`, and `publishedFrom` to `publishedTo`. */
function renamedKey(key: string, from: string, to: string) {
  if (key === from) {
    return to;
  }

  if (key === `published${capitalized(from)}`) {
    return `published${capitalized(to)}`;
  }

  return key;
}

function fields(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => fields(v, from, to));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [
        renamedKey(key, from, to),
        fields(val, from, to),
      ]),
    );
  }

  return value;
}

/** The body of a successful response; the client throws ApiError for failures. */
export function responseData<T>(response: { data?: T }): T {
  return defined(response.data, "The server sent an empty response");
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
            if (typeof metadata === "string") {
              form.set(
                "metadata",
                JSON.stringify(
                  fields(JSON.parse(metadata), "skillId", "hookId"),
                ),
              );
            }

            headers.delete("content-type");
            headers.delete("content-length");
            body = form;
          } else {
            body = await request.text();
          }
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
      ) {
        return response;
      }

      let data = fields(await response.json(), "hookId", "skillId");
      if (
        data &&
        typeof data === "object" &&
        "nextCursor" in data &&
        "hooks" in data &&
        Array.isArray(data.hooks)
      ) {
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

/**
 * A package's metadata: the `SKILL.md` front matter, or the parsed `hook.yaml`
 * manifest. Throws when the manifest is missing or invalid, or a Hook script it
 * names is missing.
 */
export function metadata(entries: PackageEntry[], kind: PackageKind = "skill") {
  if (kind === "skill") {
    return packageMetadata(entries);
  }

  if (!entries.some((e) => e.path === "hook.yaml")) {
    throw new Error("MISSING_PACKAGE_MANIFEST: hook.yaml");
  }

  const manifest = hookManifestSchema.parse(
    parse(
      entries.find((e) => e.path === "hook.yaml")?.data.toString("utf8") ?? "",
    ),
  );

  for (const implementation of Object.values(manifest.implementations)) {
    if (implementation) {
      for (const script of implementation.scripts) {
        if (!entries.some((e) => e.path === script)) {
          throw new Error(`Missing Hook script: ${script}`);
        }
      }
    }
  }

  return manifest;
}
