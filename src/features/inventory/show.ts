import { hookSchema, skillSchema } from "@barndog-ai/api-contract";
import type { RuntimeContext } from "../../runtime.js";
import { readSettings } from "../../config/settings.js";
import type { PackageKind } from "../../config/selection.js";
import type { HookHarness } from "../../harnesses/types.js";
import { hookHarnesses } from "../../harnesses/registry.js";
import { selectAsset } from "../server/catalog.js";
import { originLabel } from "../server/origin.js";
import {
  repoForOrigin,
  selectRepoAsset,
  showRepoAsset,
} from "../workspace/assets.js";
import type { RepoAsset } from "../workspace/format.js";
import { inventory, type InventoryItem } from "./index.js";

/** A Skill or Hook as `skills show` and `hooks show` describe it. */
export type PackageDetails = {
  id: string;
  kind: PackageKind;
  name: string;
  /** The origin selector, such as `team/<slug>` or `local`. */
  origin: string;
  /** A release number in a Cloud Workspace; a content hash in a local or Git one. */
  version: number | string;
  description: string;
  /** Hooks only: the events each coding tool runs it on, for the tools it implements. */
  events?: Partial<Record<HookHarness, string[]>>;
  /** Null when this machine hasn't selected it. */
  installed: Pick<InventoryItem, "state" | "harnesses" | "paths"> | null;
};

type Described = Omit<PackageDetails, "installed">;

/** What a Skill or Hook is, where it comes from, and where this machine has it. */
export async function showPackage(
  kind: PackageKind,
  name: string,
  origin: string,
  runtime: RuntimeContext,
): Promise<PackageDetails> {
  const { home } = runtime;

  const settings = await readSettings(home);
  const repo = settings && repoForOrigin(settings, runtime, origin);
  const described = repo
    ? repoDetails(selectRepoAsset(await repo.model(), kind, name, origin), kind)
    : await cloudDetails(kind, name, origin, runtime);

  const item = (await inventory(runtime)).items.find(
    (entry) => entry.id === described.id,
  );

  return {
    ...described,
    installed: item
      ? { state: item.state, harnesses: item.harnesses, paths: item.paths }
      : null,
  };
}

function repoDetails(asset: RepoAsset, kind: PackageKind): Described {
  const view = showRepoAsset(asset);
  const events = view.manifest
    ? eventsByTool((harness) => view.manifest?.implementations[harness]?.events)
    : undefined;

  return {
    id: view.id,
    kind,
    name: view.name,
    origin: view.origin,
    version: view.version,
    description: view.description,
    ...(events ? { events } : {}),
  };
}

async function cloudDetails(
  kind: PackageKind,
  name: string,
  origin: string,
  runtime: RuntimeContext,
): Promise<Described> {
  const { asset } = await selectAsset(kind, name, origin, runtime);
  if (kind === "skill") {
    const skill = skillSchema.parse(asset);

    return {
      id: skill.id,
      kind,
      name: skill.name,
      origin: originLabel(skill.origin),
      version: skill.version.number,
      description: skill.version.description,
    };
  }

  const hook = hookSchema.parse(asset);

  return {
    id: hook.id,
    kind,
    name: hook.name,
    origin: originLabel(hook.origin),
    version: hook.version.number,
    description: hook.version.description,
    events: eventsByTool(
      (harness) =>
        hook.compatibility.find((row) => row.harness === harness)
          ?.implementation?.events,
    ),
  };
}

/** Event names per tool, leaving out tools the Hook has no implementation for. */
function eventsByTool(
  eventsOf: (harness: HookHarness) => object | undefined,
): Partial<Record<HookHarness, string[]>> {
  const result: Partial<Record<HookHarness, string[]>> = {};
  for (const harness of hookHarnesses) {
    const events = eventsOf(harness);
    if (events) {
      result[harness] = Object.keys(events);
    }
  }

  return result;
}
