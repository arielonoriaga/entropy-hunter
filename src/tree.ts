import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { listFilesAt, listTrackedFiles, readFilesAt, type ChangedFile } from "./git";

export const SKIP_DIRS = new Set([
  ".git", ".entropy", "node_modules", "target", "target-musl", "dist",
  "build", "out", "vendor", "coverage", ".next", ".cache",
]);

// A snapshot of the repository's files the engine can analyze: the working
// tree as it is on disk, or the tree as it was at some commit. The engine
// only ever sees this — it never touches the filesystem or git directly.
export interface SourceTree {
  files: string[]; // every file, repo-relative, forward slashes
  read(path: string): string | null; // null = unreadable (deleted mid-run, permissions)
}

// visitedDirs guards against symlink cycles (a directory symlinked into its
// own descendant) — without it this recurses until the stack overflows.
function walkFiles(
  root: string,
  dir = root,
  acc: string[] = [],
  visitedDirs = new Set<string>(),
): string[] {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return acc; // broken symlink or race with a deleted dir — skip, don't crash
  }
  if (visitedDirs.has(real)) return acc;
  visitedDirs.add(real);

  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name) && !name.startsWith(".")) walkFiles(root, full, acc, visitedDirs);
    } else {
      acc.push(relative(root, full).replaceAll("\\", "/"));
    }
  }
  return acc;
}

const notSkipped = (path: string) => !path.split("/").some((seg) => SKIP_DIRS.has(seg));

function readFromDisk(repo: string, path: string): string | null {
  try {
    return readFileSync(join(repo, path), "utf8");
  } catch {
    return null;
  }
}

export function workingTree(repo: string): SourceTree {
  return {
    files: (listTrackedFiles(repo) ?? walkFiles(repo)).filter(notSkipped),
    read: (path) => readFromDisk(repo, path),
  };
}

// The tree at `commit`, read as cheaply as possible: only files that differ
// from the working tree come out of git (one batched call); everything else
// is byte-identical on disk, so it is read from there.
export function treeAt(
  repo: string,
  commit: string,
  diff: { changed: ChangedFile[]; deleted: string[] },
): SourceTree {
  const fromGit = [
    ...diff.changed.flatMap((c) => (c.base_path ? [c.base_path] : [])),
    ...diff.deleted,
  ];
  const blobs = readFilesAt(repo, commit, [...new Set(fromGit)]);
  return {
    files: listFilesAt(repo, commit).filter(notSkipped),
    read: (path) => blobs.get(path) ?? readFromDisk(repo, path),
  };
}
