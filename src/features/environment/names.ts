import { NAME, slugify } from "../../shared/patterns.js";

/** Kinds whose installed name is a shared native namespace (Skill folders, MCP server keys). */
export type NamedKind = "skill" | "mcp";

/**
 * An asset competing for an installed name. Clashes are resolved separately for
 * each asset kind, so a Skill and an MCP server may share a name.
 */
export type NamedAsset = {
  id: string;
  kind: NamedKind;
  name: string;
  origin: { type: string; slug?: string; id?: string };
  /** Currently owns its installed name on this machine. */
  installed: boolean;
  /** Local folder Skills are linked directly and keep their own name. */
  renamable?: boolean;
};

/** Human scope label such as local, org, team/engineering, repo/web or dev/john. */
export function originLabel(origin: {
  type: string;
  slug?: string | null;
  id?: string;
  localOnly?: boolean;
}): string {
  if (origin.localOnly || origin.type === "local") {
    return "local";
  }

  return origin.type === "org"
    ? "org"
    : `${origin.type}/${origin.slug ?? origin.id ?? "unknown"}`;
}

/**
 * Two assets competing for an installed name, with suggested renames built from
 * origin type, slug (or ID) and asset name.
 */
export type Clash = {
  kind: NamedKind;
  name: string;
  installed: NamedAsset;
  incoming: NamedAsset;
  installedRename: string;
  incomingRename: string;
};

/**
 * How the developer settles a clash: rename either asset, skip the newcomer, or
 * replace the installed one. Skip and replace are saved as disables.
 */
export type ClashChoice =
  | "rename-incoming"
  | "rename-installed"
  | "skip-incoming"
  | "replace-installed";

/**
 * Callback for deciding a name clash. Without a resolver, the newcomer is
 * skipped for the current run.
 */
export type ClashResolver = (clash: Clash) => Promise<ClashChoice>;

const rank: Record<string, number> = {
  local: 0,
  dev: 1,
  repo: 2,
  team: 3,
  org: 4,
};

/** `<origin-type>-<origin-slug>-<name>` with single hyphens, e.g. team-super-team-review. */
export function prefixedName(asset: Pick<NamedAsset, "name" | "origin">) {
  return slugify(
    [
      asset.origin.type,
      asset.origin.slug ?? asset.origin.id ?? "",
      asset.name,
    ].join("-"),
  );
}

/**
 * Whether `name` can be an installed folder or MCP key: the name pattern, at
 * most 64 characters.
 */
export function validInstalledName(name: string) {
  return NAME.test(name) && name.length <= 64;
}

/**
 * The name an asset installs under: its saved rename from `localNames`, else
 * its published name.
 */
export const installedName = (
  asset: Pick<NamedAsset, "id" | "name">,
  localNames: Record<string, string>,
) => localNames[asset.id] ?? asset.name;

/** A folder name with a trailing copy number, `review-1a2b-2`; group 1 is the rest. */
const COPY_NUMBER = /^(.*)-\d+$/;

/** `review-1a2b-2` → `review-1a2b`; undefined when there is no copy number. */
export const withoutCopyNumber = (folder: string) =>
  COPY_NUMBER.exec(folder)?.[1];

/** A Hook that needs an installed folder. */
export type HookPlacement = {
  id: string;
  name: string;
  origin: NamedAsset["origin"];
  /** A folder that must not move, such as an invalid Hook left in place. */
  kept?: string;
  /** Where this Hook is installed today. */
  current?: string;
};

/**
 * Origin prefixes are ambiguous: team a's b-c and team a-b's c read the same. Each
 * Hook gets its own folder: kept and already-installed folders stay put, a name only
 * one Hook wants stays plain, and the rest take an ID suffix.
 */
export function hookFolders(
  hooks: readonly HookPlacement[],
  localNames: Record<string, string>,
) {
  const folders = new Map<string, string>();
  const used = new Set<string>();
  const claim = (hook: HookPlacement, folder: string) => {
    folders.set(hook.id, folder);
    used.add(folder);
  };

  const plain = (hook: HookPlacement) =>
    localNames[hook.id] ?? prefixedName(hook);

  const idText = (hook: HookPlacement) =>
    hook.id.replace(/[^a-z0-9]/gi, "").toLowerCase();

  const suffixed = (hook: HookPlacement) =>
    `${plain(hook)}-${idText(hook).slice(0, 8)}`;

  const whole = (hook: HookPlacement) => `${plain(hook)}-${idText(hook)}`;
  const ordered = [...hooks].sort((a, b) => a.id.localeCompare(b.id));
  const open = () => ordered.filter((hook) => !folders.has(hook.id));
  for (const hook of ordered) {
    if (hook.kept) {
      claim(hook, hook.kept);
    }
  }

  for (const hook of open()) {
    if (
      hook.current &&
      !used.has(hook.current) &&
      (hook.current === plain(hook) ||
        hook.current === suffixed(hook) ||
        hook.current === whole(hook) ||
        withoutCopyNumber(hook.current) === whole(hook))
    ) {
      claim(hook, hook.current);
    }
  }

  const wanting = open().map(plain);
  for (const hook of open()) {
    if (
      !used.has(plain(hook)) &&
      wanting.filter((folder) => folder === plain(hook)).length === 1
    ) {
      claim(hook, plain(hook));
    }
  }

  for (const hook of open()) {
    let folder = used.has(suffixed(hook)) ? whole(hook) : suffixed(hook);
    for (let n = 2; used.has(folder); n++) {
      folder = `${whole(hook)}-${n}`;
    }

    claim(hook, folder);
  }

  return folders;
}

/** Drops automatic renames whose plain name is free again; explicit names stay. */
export function restoreNames(
  assets: readonly NamedAsset[],
  localNames: Record<string, string>,
): Record<string, string> {
  const next = { ...localNames };
  for (const asset of assets) {
    if (asset.renamable === false || next[asset.id] !== prefixedName(asset)) {
      continue;
    }

    const taken = assets.some(
      (other) =>
        other.id !== asset.id &&
        other.kind === asset.kind &&
        installedName(other, next) === asset.name,
    );

    if (!taken) {
      delete next[asset.id];
    }
  }

  return next;
}

/** The first clash in a stable order; the asset already installed (or most specific scope) keeps the name. */
export function findClash(
  assets: readonly NamedAsset[],
  localNames: Record<string, string>,
): Clash | undefined {
  const groups = new Map<string, NamedAsset[]>();
  for (const asset of assets) {
    const key = `${asset.kind}\0${installedName(asset, localNames)}`;
    groups.set(key, [...(groups.get(key) ?? []), asset]);
  }

  for (const [, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const [installed, incoming] = [...group].sort(
      (a, b) =>
        Number(b.installed) - Number(a.installed) ||
        (rank[a.origin.type] ?? 9) - (rank[b.origin.type] ?? 9) ||
        a.id.localeCompare(b.id),
    );

    if (!installed || !incoming) {
      continue;
    }

    return {
      kind: installed.kind,
      name: installedName(installed, localNames),
      installed,
      incoming,
      installedRename: prefixedName(installed),
      incomingRename: prefixedName(incoming),
    };
  }

  return undefined;
}

/**
 * The renames and disables to save after settling clashes, and the clashes
 * skipped for this run only.
 */
export type ClashOutcome = {
  localNames: Record<string, string>;
  disabledAssetIds: string[];
  /** Skipped for this run only; nothing was persisted. */
  skipped: Clash[];
};

/**
 * Resolves every clash. With a resolver each decision is persisted; without one,
 * the installed asset keeps its name and the newcomer is skipped for this run.
 */
export async function resolveClashes(
  assets: readonly NamedAsset[],
  localNames: Record<string, string>,
  resolver?: ClashResolver,
): Promise<ClashOutcome> {
  let names = restoreNames(assets, localNames);
  let active = [...assets];
  const disabled: string[] = [];
  const skipped: Clash[] = [];
  for (let guard = 0; guard < assets.length * 4 + 4; guard++) {
    const clash = findClash(active, names);
    if (!clash) {
      return { localNames: names, disabledAssetIds: disabled, skipped };
    }

    let choice = resolver ? await resolver(clash) : "skip-incoming";
    const renames: Partial<Record<ClashChoice, NamedAsset>> = {
      "rename-incoming": clash.incoming,
      "rename-installed": clash.installed,
    };

    const rename = renames[choice];

    if (rename) {
      const name = prefixedName(rename);
      if (
        rename.renamable === false ||
        !validInstalledName(name) ||
        active.some(
          (other) =>
            other.id !== rename.id &&
            other.kind === rename.kind &&
            installedName(other, names) === name,
        )
      ) {
        choice = "skip-incoming";
      } else {
        names = { ...names, [rename.id]: name };
        continue;
      }
    }

    const removed =
      choice === "replace-installed" ? clash.installed : clash.incoming;

    active = active.filter((asset) => asset.id !== removed.id);
    if (resolver) {
      disabled.push(removed.id);
    } else {
      skipped.push(clash);
    }
  }

  throw new Error("Unable to resolve installed name clashes");
}
