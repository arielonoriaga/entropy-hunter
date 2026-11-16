import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { repoIdentity } from "./git";
import { Storage } from "./storage";

// The incremental cache lives outside the repository, one database per
// repository shared by all of its worktrees: a fresh worktree (or a repo that
// never ran `entropy init`) starts warm, and nothing is written into the
// project. `.entropy/entropy.db` holds only what is the project's own —
// snapshots and history.
//
// ENTROPY_CACHE_DIR overrides the location; ENTROPY_NO_CACHE=1 disables it.

export function cacheRoot(): string {
  return (
    process.env.ENTROPY_CACHE_DIR ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "entropy-hunter")
  );
}

export function cachePath(repo: string): string {
  let real = repo;
  try {
    real = realpathSync(repo);
  } catch {
    // nonexistent path: later steps report it; any stable name will do here
  }
  const identity = repoIdentity(repo) ?? real;
  return join(cacheRoot(), `${basename(real)}-${Bun.hash(identity).toString(36)}.db`);
}

// null when caching is disabled or the cache cannot be opened (read-only
// home, sandbox): analysis then simply runs cold — never an error.
export function openCache(repo: string): Storage | null {
  if (process.env.ENTROPY_NO_CACHE === "1") return null;
  try {
    return new Storage(cachePath(repo));
  } catch {
    return null;
  }
}
