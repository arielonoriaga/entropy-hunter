import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export interface FileChurn {
  commits: number;
  lines_added: number;
  lines_deleted: number;
  // Recency-weighted commit count (90-day half-life): recent commits count
  // more than old ones, so a file quiet for a year doesn't outrank one
  // actively churning this week just because it has more raw commits.
  weighted_commits: number;
  // Recent-half vs older-half commit frequency within the window.
  trend: "accelerating" | "stable" | "cooling";
}

export class GitError extends Error {}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

// Best-effort probe: false covers "not a repo" AND transient failures alike,
// which is fine here — every other caller of git() must fail loudly instead.
export function isGitRepo(repo: string): boolean {
  try {
    return git(repo, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

// Not being a git repo is an expected, common state (a fresh checkout of a
// tarball, a scratch fixture dir) — degrade to "unknown" rather than throw.
// A git command failing INSIDE a real repo (corrupt .git, permissions) still
// throws via git(), since that's a genuine unexpected failure.
export function headCommit(repo: string): string {
  if (!isGitRepo(repo)) return "unknown";
  return git(repo, ["rev-parse", "HEAD"]).trim() || "unknown";
}

export function currentCommit(repo: string): string {
  if (!isGitRepo(repo)) return "unknown";
  return git(repo, ["rev-parse", "--short", "HEAD"]).trim() || "unknown";
}

export function repoName(repo: string): string {
  if (!isGitRepo(repo)) return basename(repo);
  const top = git(repo, ["rev-parse", "--show-toplevel"]).trim();
  return basename(top || repo);
}

export function listTrackedFiles(repo: string): string[] | null {
  if (!isGitRepo(repo)) return null;
  const out = git(repo, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  return out.split("\0").filter(Boolean);
}

// "30d" | "12w" | "6m" | "1y" | "YYYY-MM-DD" → ISO date for git --since.
// Throws on anything else instead of silently passing garbage to git, which
// would make git log fail and churn silently come back empty (git.ts used to).
export function sinceToDate(since: string, now = new Date()): string {
  const rel = since.match(/^(\d+)([dwmy])$/);
  if (rel) {
    const n = Number(rel[1]);
    if (n === 0) throw new GitError(`--since window cannot be 0${rel[2]}`);
    const days = { d: 1, w: 7, m: 30, y: 365 }[rel[2] as "d" | "w" | "m" | "y"];
    return new Date(now.getTime() - n * days * 86400_000).toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(since)) return since;
  throw new GitError(`invalid --since "${since}" — expected e.g. "30d", "12w", "6m", "1y", or "YYYY-MM-DD"`);
}

const HALF_LIFE_DAYS = 90;

function weighted(ageDays: number): number {
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

export function churn(repo: string, since: string): Map<string, FileChurn> {
  const sinceDate = sinceToDate(since); // validate the window even for non-repos
  if (!isGitRepo(repo)) return new Map(); // no history to measure — not an error
  const windowStart = new Date(`${sinceDate}T00:00:00Z`).getTime();
  const now = Date.now();

  let out: string;
  try {
    out = git(repo, [
      "log",
      `--since=${sinceDate}`,
      "--numstat",
      "--no-merges", // merge commits don't represent authored changes to a file
      "--no-renames",
      "--use-mailmap", // collapse an author's multiple committer identities
      // %H is hex, %at is digits — neither can collide with the "|" delimiter
      // or a numstat line's own tab/path structure, so plain newlines suffice.
      "--format=@%H|%at",
    ]);
  } catch (err) {
    throw new GitError(
      `git log failed for --since=${sinceDate} in ${repo}: ${(err as Error).message}`,
    );
  }

  const result = new Map<string, FileChurn>();
  const perFileTimestamps = new Map<string, number[]>();
  let currentTs = now;
  const seenThisCommit = new Set<string>();

  for (const line of out.split("\n")) {
    const header = line.match(/^@[0-9a-f]+\|(\d+)$/);
    if (header) {
      seenThisCommit.clear();
      currentTs = Number(header[1]) * 1000;
      continue;
    }
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const [, added, deleted, path] = m;
    const entry = result.get(path) ?? {
      commits: 0, lines_added: 0, lines_deleted: 0, weighted_commits: 0, trend: "stable" as const,
    };
    if (!seenThisCommit.has(path)) {
      entry.commits++;
      entry.weighted_commits += weighted((now - currentTs) / 86400_000);
      seenThisCommit.add(path);
      const ts = perFileTimestamps.get(path) ?? [];
      ts.push(currentTs);
      perFileTimestamps.set(path, ts);
    }
    if (added !== "-") entry.lines_added += Number(added);
    if (deleted !== "-") entry.lines_deleted += Number(deleted);
    result.set(path, entry);
  }

  const midpoint = (windowStart + now) / 2;
  for (const [path, entry] of result) {
    entry.weighted_commits = Math.round(entry.weighted_commits * 100) / 100;
    const timestamps = perFileTimestamps.get(path) ?? [];
    const recent = timestamps.filter((t) => t >= midpoint).length;
    const older = timestamps.length - recent;
    if (older === 0) entry.trend = recent > 0 ? "accelerating" : "stable";
    else if (recent / older > 1.5) entry.trend = "accelerating";
    else if (recent / older < 0.67) entry.trend = "cooling";
    else entry.trend = "stable";
  }
  return result;
}
