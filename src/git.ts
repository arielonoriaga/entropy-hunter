import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export interface FileChurn {
  commits: number;
  lines_added: number;
  lines_deleted: number;
}

function git(repo: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

export function isGitRepo(repo: string): boolean {
  return git(repo, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
}

export function headCommit(repo: string): string {
  return git(repo, ["rev-parse", "HEAD"]).trim() || "unknown";
}

export function currentCommit(repo: string): string {
  return git(repo, ["rev-parse", "--short", "HEAD"]).trim() || "unknown";
}

export function repoName(repo: string): string {
  const top = git(repo, ["rev-parse", "--show-toplevel"]).trim();
  return basename(top || repo);
}

export function listTrackedFiles(repo: string): string[] | null {
  if (!isGitRepo(repo)) return null;
  const out = git(repo, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  return out.split("\0").filter(Boolean);
}

// "30d" | "12w" | "6m" | "1y" → ISO date for git --since
export function sinceToDate(since: string, now = new Date()): string {
  const m = since.match(/^(\d+)([dwmy])$/);
  if (!m) return since; // pass through raw dates like "2026-01-01"
  const n = Number(m[1]);
  const days = { d: 1, w: 7, m: 30, y: 365 }[m[2] as "d" | "w" | "m" | "y"];
  const then = new Date(now.getTime() - n * days * 86400_000);
  return then.toISOString().slice(0, 10);
}

export function churn(repo: string, since: string): Map<string, FileChurn> {
  const result = new Map<string, FileChurn>();
  const out = git(repo, [
    "log",
    `--since=${sinceToDate(since)}`,
    "--numstat",
    "--no-renames",
    "--format=@%H",
  ]);
  if (!out) return result;
  const seenThisCommit = new Set<string>();
  for (const line of out.split("\n")) {
    if (line.startsWith("@")) {
      seenThisCommit.clear();
      continue;
    }
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const [, added, deleted, path] = m;
    const entry = result.get(path) ?? { commits: 0, lines_added: 0, lines_deleted: 0 };
    if (!seenThisCommit.has(path)) {
      entry.commits++;
      seenThisCommit.add(path);
    }
    if (added !== "-") entry.lines_added += Number(added);
    if (deleted !== "-") entry.lines_deleted += Number(deleted);
    result.set(path, entry);
  }
  return result;
}
