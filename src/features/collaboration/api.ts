/**
 * The server routes the working-copy and review code calls, once per package
 * kind. Skills and Hooks have separate routes and schemas in the contract
 * (`/v1/skills` and `/v1/skill-changes`, `/v1/hooks` and `/v1/hook-changes`);
 * `packageApi()` picks the kind's set, so the code above it never names a route.
 *
 * Each kind keeps its contract's own shape: a Hook proposal, version or upload
 * names its asset `hookId`, a Skill one `skillId`. Code shared by both kinds
 * holds the asset under the neutral `assetId` (`PackageUpload`, the working-copy
 * record) and reads a result's with `changeAssetId()`.
 */
import { z } from "zod";
import {
  changeSchema,
  changeUploadSchema,
  hookChangeSchema,
  hookChangeUploadSchema,
  hookSchema,
  hookVersionSchema,
  skillSchema,
  versionSchema,
  type changeActionSchema,
  type commentInputSchema,
  type discussionInputSchema,
  type reviewInputSchema,
  type threadResolveSchema,
} from "@barndog-ai/api-contract";
import type { FileDiff } from "@barndog-ai/api-contract/collaboration";

import type { PackageKind } from "../../config/selection.js";
import type { Connection } from "../../config/settings.js";
import { type ApiClient, apiClient } from "../auth/transport.js";
import { parsed, responseData } from "../server/client.js";
import type { Page } from "../server/pages.js";
import type { PackageUpload } from "./workspace-store.js";
import type { PackageDownload } from "../workspace/packages.js";
import type {
  PackageChange,
  PublishedVersion,
  VersionFiles,
} from "./results.js";

/** The published package's identity and newest version, alike for both kinds. */
type PublishedPackage = {
  id: string;
  version: { id: string; number: number; commit: string };
};

type ChangeAction = z.input<typeof changeActionSchema>;

type ReviewInput = z.input<typeof reviewInputSchema>;

type DiscussionInput = z.input<typeof discussionInputSchema>;

type CommentInput = ChangeAction & z.input<typeof commentInputSchema>;

type ThreadResolve = z.input<typeof threadResolveSchema>;

type ChangeDiffQuery = { revision?: number; fromRevision?: number };

export type PackageApi = {
  published(id: string): Promise<PublishedPackage>;
  /** Newest last. */
  versions(id: string): Promise<PublishedVersion[]>;
  content(id: string, version: number): Promise<VersionFiles>;
  diff(id: string, range: { from: number; to: number }): Promise<FileDiff[]>;
  versionPackage(id: string, version: number): PackageDownload;

  changes(cursor: string | undefined): Promise<Page<PackageChange>>;
  change(id: string): Promise<PackageChange>;
  changeDiff(id: string, query: ChangeDiffQuery): Promise<FileDiff[]>;
  changePackage(id: string, revision: number): PackageDownload;
  /** Opens a proposal from the upload's metadata and its package archive. */
  submit(upload: PackageUpload, archive: Blob): Promise<PackageChange>;
  /** Adds a revision to an open proposal. */
  revise(
    id: string,
    upload: PackageUpload,
    archive: Blob,
  ): Promise<PackageChange>;

  review(id: string, body: ReviewInput): Promise<PackageChange>;
  reject(id: string, body: ChangeAction): Promise<PackageChange>;
  merge(id: string, body: ChangeAction): Promise<PackageChange>;
  discuss(id: string, body: DiscussionInput): Promise<PackageChange>;
  comment(
    id: string,
    threadId: string,
    body: CommentInput,
  ): Promise<PackageChange>;
  applySuggestion(
    id: string,
    threadId: string,
    body: ChangeAction,
  ): Promise<PackageChange>;
  resolve(
    id: string,
    threadId: string,
    body: ThreadResolve,
  ): Promise<PackageChange>;
};

/** The multipart body both kinds' proposal routes take. */
function uploadForm(metadata: unknown, archive: Blob) {
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  form.set("package", archive, "package.tar.gz");

  return form;
}

const byId = (id: string) => ({ path: { id } });
const thread = (id: string, threadId: string) => ({ path: { id, threadId } });

/** The upload without its neutral asset ID, which each kind names its own way. */
function uploadFields({ assetId, ...fields }: PackageUpload) {
  return { assetId, fields };
}

function skillApi(client: ApiClient): PackageApi {
  const metadata = (upload: PackageUpload) => {
    const { assetId, fields } = uploadFields(upload);

    return changeUploadSchema.parse({ ...fields, skillId: assetId });
  };

  const change = (call: Promise<{ data?: unknown }>) =>
    parsed(changeSchema, call);

  return {
    published: (id) =>
      parsed(skillSchema, client.GET("/v1/skills/{id}", { params: byId(id) })),
    versions: (id) =>
      parsed(
        z.array(versionSchema),
        client.GET("/v1/skills/{id}/versions", { params: byId(id) }),
      ),
    content: async (id, version) =>
      responseData(
        await client.GET("/v1/skills/{id}/content", {
          params: { ...byId(id), query: { version } },
        }),
      ),
    diff: async (id, range) =>
      responseData(
        await client.GET("/v1/skills/{id}/diff", {
          params: { ...byId(id), query: range },
        }),
      ),
    versionPackage: (id, version) =>
      client.GET("/v1/skills/{id}/versions/{version}/package", {
        params: { path: { id, version } },
        parseAs: "stream",
      }),

    changes: async (cursor) => {
      const page = responseData(
        await client.GET("/v1/skill-changes", {
          params: { query: { cursor } },
        }),
      );

      return {
        items: page.changes.map((item) => changeSchema.parse(item)),
        nextCursor: page.nextCursor,
      };
    },
    change: (id) =>
      change(client.GET("/v1/skill-changes/{id}", { params: byId(id) })),
    changeDiff: async (id, query) =>
      responseData(
        await client.GET("/v1/skill-changes/{id}/diff", {
          params: { ...byId(id), query },
        }),
      ),
    changePackage: (id, revision) =>
      client.GET("/v1/skill-changes/{id}/package", {
        params: { ...byId(id), query: { revision } },
        parseAs: "stream",
      }),
    submit: (upload, archive) =>
      change(
        client.POST("/v1/skill-changes", {
          body: uploadForm(metadata(upload), archive),
        }),
      ),
    revise: (id, upload, archive) =>
      change(
        client.PUT("/v1/skill-changes/{id}/revisions", {
          params: byId(id),
          body: uploadForm(metadata(upload), archive),
        }),
      ),

    review: (id, body) =>
      change(
        client.POST("/v1/skill-changes/{id}/reviews", {
          params: byId(id),
          body,
        }),
      ),
    reject: (id, body) =>
      change(
        client.POST("/v1/skill-changes/{id}/reject", {
          params: byId(id),
          body,
        }),
      ),
    merge: (id, body) =>
      change(
        client.POST("/v1/skill-changes/{id}/merge", { params: byId(id), body }),
      ),
    discuss: (id, body) =>
      change(
        client.POST("/v1/skill-changes/{id}/discussions", {
          params: byId(id),
          body,
        }),
      ),
    comment: (id, threadId, body) =>
      change(
        client.POST("/v1/skill-changes/{id}/discussions/{threadId}/comments", {
          params: thread(id, threadId),
          body,
        }),
      ),
    applySuggestion: (id, threadId, body) =>
      change(
        client.POST("/v1/skill-changes/{id}/discussions/{threadId}/apply", {
          params: thread(id, threadId),
          body,
        }),
      ),
    resolve: (id, threadId, body) =>
      change(
        client.POST("/v1/skill-changes/{id}/discussions/{threadId}/resolve", {
          params: thread(id, threadId),
          body,
        }),
      ),
  };
}

function hookApi(client: ApiClient): PackageApi {
  const metadata = (upload: PackageUpload) => {
    const { assetId, fields } = uploadFields(upload);

    return hookChangeUploadSchema.parse({ ...fields, hookId: assetId });
  };

  const change = (call: Promise<{ data?: unknown }>) =>
    parsed(hookChangeSchema, call);

  return {
    published: (id) =>
      parsed(hookSchema, client.GET("/v1/hooks/{id}", { params: byId(id) })),
    versions: (id) =>
      parsed(
        z.array(hookVersionSchema),
        client.GET("/v1/hooks/{id}/versions", { params: byId(id) }),
      ),
    content: async (id, version) =>
      responseData(
        await client.GET("/v1/hooks/{id}/content", {
          params: { ...byId(id), query: { version } },
        }),
      ),
    diff: async (id, range) =>
      responseData(
        await client.GET("/v1/hooks/{id}/diff", {
          params: { ...byId(id), query: range },
        }),
      ),
    versionPackage: (id, version) =>
      client.GET("/v1/hooks/{id}/versions/{version}/package", {
        params: { path: { id, version } },
        parseAs: "stream",
      }),

    changes: async (cursor) => {
      const page = responseData(
        await client.GET("/v1/hook-changes", { params: { query: { cursor } } }),
      );

      return {
        items: page.changes.map((item) => hookChangeSchema.parse(item)),
        nextCursor: page.nextCursor,
      };
    },
    change: (id) =>
      change(client.GET("/v1/hook-changes/{id}", { params: byId(id) })),
    changeDiff: async (id, query) =>
      responseData(
        await client.GET("/v1/hook-changes/{id}/diff", {
          params: { ...byId(id), query },
        }),
      ),
    changePackage: (id, revision) =>
      client.GET("/v1/hook-changes/{id}/package", {
        params: { ...byId(id), query: { revision } },
        parseAs: "stream",
      }),
    submit: (upload, archive) =>
      change(
        client.POST("/v1/hook-changes", {
          body: uploadForm(metadata(upload), archive),
        }),
      ),
    revise: (id, upload, archive) =>
      change(
        client.PUT("/v1/hook-changes/{id}/revisions", {
          params: byId(id),
          body: uploadForm(metadata(upload), archive),
        }),
      ),

    review: (id, body) =>
      change(
        client.POST("/v1/hook-changes/{id}/reviews", {
          params: byId(id),
          body,
        }),
      ),
    reject: (id, body) =>
      change(
        client.POST("/v1/hook-changes/{id}/reject", { params: byId(id), body }),
      ),
    merge: (id, body) =>
      change(
        client.POST("/v1/hook-changes/{id}/merge", { params: byId(id), body }),
      ),
    discuss: (id, body) =>
      change(
        client.POST("/v1/hook-changes/{id}/discussions", {
          params: byId(id),
          body,
        }),
      ),
    comment: (id, threadId, body) =>
      change(
        client.POST("/v1/hook-changes/{id}/discussions/{threadId}/comments", {
          params: thread(id, threadId),
          body,
        }),
      ),
    applySuggestion: (id, threadId, body) =>
      change(
        client.POST("/v1/hook-changes/{id}/discussions/{threadId}/apply", {
          params: thread(id, threadId),
          body,
        }),
      ),
    resolve: (id, threadId, body) =>
      change(
        client.POST("/v1/hook-changes/{id}/discussions/{threadId}/resolve", {
          params: thread(id, threadId),
          body,
        }),
      ),
  };
}

const apis: Record<PackageKind, (client: ApiClient) => PackageApi> = {
  skill: skillApi,
  hook: hookApi,
};

/** The review and working-copy routes of `kind` on the connection's server. */
export function packageApi(
  kind: PackageKind,
  conn: Pick<Connection, "server">,
  home: string,
): PackageApi {
  return apis[kind](apiClient(conn.server, home));
}
