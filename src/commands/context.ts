import type {
  CollaborationAction,
  CollaborationOptions,
} from "../features/collaboration/index.js";
import type { SyncEvent } from "../features/skills/sync.js";
import type { SyncOptions } from "../features/environment/sync.js";
import type { EnvironmentOptions } from "../features/environment/operations.js";
import type { CapabilityOptions } from "../features/capabilities/index.js";
import type { Inventory } from "../features/inventory/index.js";
import type { CatalogAsset } from "../features/catalog/index.js";
import type { AssetKind } from "../features/asset-selection/types.js";

/** Output and prompting preferences resolved from global flags and the terminal. */
export type Mode = { json: boolean; interactive: boolean };

export type CommandContext = {
  environment: (
    action: string,
    options: EnvironmentOptions,
  ) => Promise<unknown>;
  capability: (action: string, options: CapabilityOptions) => Promise<unknown>;
  login: (options: {
    server?: string;
    browser: boolean;
    force?: boolean;
  }) => Promise<void>;
  logout: () => Promise<void>;
  authStatus: () => Promise<void>;
  setup: (
    restart: boolean,
    server?: string,
    options?: { local?: boolean; repo?: string; browser?: boolean },
  ) => Promise<void>;
  synchronize: (
    configPath?: string,
    options?: Pick<SyncOptions, "dryRun" | "refresh" | "prompt">,
  ) => Promise<SyncEvent[]>;
  inventory: () => Promise<Inventory>;
  searchCatalog: (kind: AssetKind) => Promise<CatalogAsset[]>;
  collaborate: (
    action: CollaborationAction,
    options: CollaborationOptions,
  ) => Promise<unknown>;
  write: (message: string) => void;
  mode: Mode;
};
