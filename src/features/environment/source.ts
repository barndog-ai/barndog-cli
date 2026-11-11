import type { McpDefinition } from "@barndog-ai/api-contract";

import type { Connection } from "../../config/settings.js";
import type { AssetCatalog, AssetReference } from "../asset-selection/types.js";

/** Who a pending sync journal belongs to. */
export type JournalIdentity = Connection | { workspaceId: string };

/** Where sync gets assets from. Cloud and repo sources implement this directly. */
export type WorkspaceSource = {
  /** Relative folder under ~/.barndog/packages that keeps this source's cache apart. */
  cacheKey: string;
  /** Further cache partitions this source reads from, kept tidy by sync. */
  extraCacheKeys?: string[];
  journal: JournalIdentity;
  catalog(): Promise<AssetCatalog>;
  /** Resolves to a validated, immutable package folder. */
  skillOrHookPackage(
    kind: "skill" | "hook",
    asset: AssetReference,
  ): Promise<string>;
  mcpDefinition(asset: AssetReference): Promise<McpDefinition>;
  /** Assets present in the catalog whose content cannot be installed, with why. */
  invalidAssets(): Promise<ReadonlyMap<string, string>>;
  /** Things sync should tell the developer, such as working from an old fetch. */
  notices(): readonly string[];
  /** Content this source had to leave out, in a sentence each. */
  warnings?(): Promise<readonly string[]>;
};
