import { skillName } from "../skills/validation.js";

/** Kinds whose installed name is a shared native namespace (Skill folders, MCP server keys). */
export type NamedKind = "skill" | "mcp";

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
  if (origin.localOnly || origin.type === "local") return "local";
  return origin.type === "org"
    ? "org"
    : `${origin.type}/${origin.slug ?? origin.id ?? "unknown"}`;
}

export type Clash = {
  kind: NamedKind;
  name: string;
  installed: NamedAsset;
  incoming: NamedAsset;
  installedRename: string;
  incomingRename: string;
};

export type ClashChoice =
  | "rename-incoming"
  | "rename-installed"
  | "skip-incoming"
  | "replace-installed";

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
  return [
    asset.origin.type,
    asset.origin.slug ?? asset.origin.id ?? "",
    asset.name,
  ]
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function validInstalledName(name: string) {
  return skillName.test(name) && name.length <= 64;
}

export const installedName = (
  asset: Pick<NamedAsset, "id" | "name">,
  localNames: Record<string, string>,
) => localNames[asset.id] ?? asset.name;

/**
 * Origin prefixes are ambiguous: team a's b-c and team a-b's c read the same. Each
 * Hook gets its own folder: kept and already-installed folders stay put, a name only
 * one Hook wants stays plain, and the rest take an ID suffix.
 */
export function hookFolders(
  hooks: readonly {
    id: string;
    name: string;
    origin: NamedAsset["origin"];
    /** A folder that must not move, such as an invalid Hook left in place. */
    kept?: string;
    /** Where this Hook is installed today. */
    current?: string;
  }[],
  localNames: Record<string, string>,
) {
  type Hook = (typeof hooks)[number];

  const folders = new Map<string, string>();
  const used = new Set<string>();
  const claim = (hook: Hook, folder: string) => {
    folders.set(hook.id, folder);
    used.add(folder);
  };
  const plain = (hook: Hook) => localNames[hook.id] ?? prefixedName(hook);
  const idText = (hook: Hook) =>
    hook.id.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const suffixed = (hook: Hook) => `${plain(hook)}-${idText(hook).slice(0, 8)}`;
  const whole = (hook: Hook) => `${plain(hook)}-${idText(hook)}`;
  const ordered = [...hooks].sort((a, b) => a.id.localeCompare(b.id));
  const open = () => ordered.filter((hook) => !folders.has(hook.id));
  for (const hook of ordered) if (hook.kept) claim(hook, hook.kept);
  for (const hook of open())
    if (
      hook.current &&
      !used.has(hook.current) &&
      (hook.current === plain(hook) ||
        hook.current === suffixed(hook) ||
        hook.current === whole(hook) ||
        hook.current.match(/^(.*)-\d+$/)?.[1] === whole(hook))
    )
      claim(hook, hook.current);
  const wanting = open().map(plain);
  for (const hook of open())
    if (
      !used.has(plain(hook)) &&
      wanting.filter((folder) => folder === plain(hook)).length === 1
    )
      claim(hook, plain(hook));
  for (const hook of open()) {
    let folder = used.has(suffixed(hook)) ? whole(hook) : suffixed(hook);
    for (let n = 2; used.has(folder); n++) folder = `${whole(hook)}-${n}`;
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
    if (asset.renamable === false || next[asset.id] !== prefixedName(asset))
      continue;
    const taken = assets.some(
      (other) =>
        other.id !== asset.id &&
        other.kind === asset.kind &&
        installedName(other, next) === asset.name,
    );
    if (!taken) delete next[asset.id];
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
  for (const [key, group] of [...groups].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (group.length < 2) continue;
    const [installed, incoming] = [...group].sort(
      (a, b) =>
        Number(b.installed) - Number(a.installed) ||
        (rank[a.origin.type] ?? 9) - (rank[b.origin.type] ?? 9) ||
        a.id.localeCompare(b.id),
    ) as [NamedAsset, NamedAsset];
    return {
      kind: installed.kind,
      name: key.split("\0")[1]!,
      installed,
      incoming,
      installedRename: prefixedName(installed),
      incomingRename: prefixedName(incoming),
    };
  }
  return undefined;
}

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
    if (!clash)
      return { localNames: names, disabledAssetIds: disabled, skipped };
    let choice = resolver ? await resolver(clash) : "skip-incoming";
    const rename =
      choice === "rename-incoming"
        ? clash.incoming
        : choice === "rename-installed"
          ? clash.installed
          : undefined;
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
      )
        choice = "skip-incoming";
      else {
        names = { ...names, [rename.id]: name };
        continue;
      }
    }
    const removed =
      choice === "replace-installed" ? clash.installed : clash.incoming;
    active = active.filter((asset) => asset.id !== removed.id);
    if (resolver) disabled.push(removed.id);
    else skipped.push(clash);
  }
  throw new Error("Unable to resolve installed name clashes");
}
