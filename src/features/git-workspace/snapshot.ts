import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

import { git } from "./git.js";
import { defined } from "../../lookup.js";

export type SnapshotEntry = { path: string; mode: string; hash: string };

/** One immutable view of a workspace: every path, with Git's object names. */
export type Snapshot = {
  entries: readonly SnapshotEntry[];
  readBlobs(hashes: readonly string[]): Promise<Map<string, Buffer>>;
};

export const TREE_MODE = "040000";

export const isBlob = (mode: string) => mode === "100644" || mode === "100755";

export function gitObjectHash(type: "blob" | "tree", content: Buffer) {
  return createHash("sha1")
    .update(`${type} ${content.length}\0`)
    .update(content)
    .digest("hex");
}

function treeObject(children: { name: string; mode: string; hash: string }[]) {
  const key = (child: { name: string; mode: string }) =>
    Buffer.from(child.mode === TREE_MODE ? `${child.name}/` : child.name);
  return Buffer.concat(
    [...children]
      .sort((a, b) => Buffer.compare(key(a), key(b)))
      .flatMap((child) => [
        Buffer.from(`${child.mode.replace(/^0+/, "")} ${child.name}\0`),
        Buffer.from(child.hash, "hex"),
      ]),
  );
}

// Finder scatters these through any folder a developer browses.
const ignored = new Set([".git", ".DS_Store"]);

/** Reads a folder and names it exactly as Git would, without needing Git. */
export async function folderSnapshot(root: string): Promise<Snapshot> {
  const entries: SnapshotEntry[] = [];
  const paths = new Map<string, string>();

  async function visit(relative: string): Promise<string> {
    const children: { name: string; mode: string; hash: string }[] = [];
    for (const name of await readdir(join(root, relative))) {
      if (ignored.has(name)) continue;
      const path = relative ? `${relative}/${name}` : name;
      const absolute = join(root, path);
      const info = await lstat(absolute);
      let mode: string;
      let hash: string;
      if (info.isDirectory()) {
        hash = await visit(path);
        mode = TREE_MODE;
      } else if (info.isSymbolicLink()) {
        hash = gitObjectHash("blob", Buffer.from(await readlink(absolute)));
        mode = "120000";
      } else if (info.isFile()) {
        hash = gitObjectHash("blob", await readFile(absolute));
        mode = info.mode & 0o111 ? "100755" : "100644";
        paths.set(hash, absolute);
      } else continue;
      entries.push({ path, mode, hash });
      children.push({ name, mode, hash });
    }
    return gitObjectHash("tree", treeObject(children));
  }

  await visit("");
  return {
    entries,
    readBlobs: async (hashes) => {
      const blobs = new Map<string, Buffer>();
      for (const hash of new Set(hashes))
        blobs.set(
          hash,
          await readFile(defined(paths.get(hash), `Unknown blob ${hash}`)),
        );
      return blobs;
    },
  };
}

/** Reads a commit through Git plumbing, so .gitattributes cannot alter the bytes. */
export async function gitSnapshot(
  repo: string,
  commit: string,
): Promise<Snapshot> {
  const listing = await git(["ls-tree", "-r", "-t", "-z", commit], { repo });
  const entries = listing
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line): SnapshotEntry => {
      const [meta, path] = [
        line.slice(0, line.indexOf("\t")),
        line.slice(line.indexOf("\t") + 1),
      ];
      const [mode, , hash] = meta.split(" ");
      if (!mode || !hash)
        throw new Error(`Unexpected git ls-tree line: ${line}`);
      return { path, mode, hash };
    });
  return {
    entries,
    readBlobs: async (hashes) => {
      const unique = [...new Set(hashes)];
      if (!unique.length) return new Map();
      const output = await git(["cat-file", "--batch"], {
        repo,
        input: unique.join("\n") + "\n",
      });
      const blobs = new Map<string, Buffer>();
      let offset = 0;
      for (const hash of unique) {
        const end = output.indexOf(0x0a, offset);
        const size = Number(output.toString("utf8", offset, end).split(" ")[2]);
        blobs.set(hash, output.subarray(end + 1, end + 1 + size));
        offset = end + 1 + size + 1;
      }
      return blobs;
    },
  };
}
