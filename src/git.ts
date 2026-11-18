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

const MAX_GIT_LOG_BYTES = 256 * 1024 * 1024;
const MS_PER_DAY = 86_400_000;
const MS_PER_SECOND = 1000;

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_GIT_LOG_BYTES,
    // Capture stderr: a failed probe ("not a git repository") is an expected
    // answer, not something to print; real failures still carry it in the error.
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// Best-effort probe: false covers "not a repo" AND transient failures alike,
// which is fine here — every other caller of git() must fail loudly instead.
// Memoized per process: every helper below asks, and each ask was a spawn.
const repoProbe = new Map<string, boolean>();
export function isGitRepo(repo: string): boolean {
  let known = repoProbe.get(repo);
  if (known === undefined) {
    try {
      known = git(repo, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
    } catch {
      known = false;
    }
    repoProbe.set(repo, known);
  }
  return known;
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

// What makes two paths "the same repository" for caching: the shared git
// directory (identical across worktrees) plus the subdirectory analyzed.
// null outside git.
export function repoIdentity(repo: string): string | null {
  if (!isGitRepo(repo)) return null;
  const [commonDir, prefix] = git(repo, [
    "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-prefix",
  ]).split("\n");
  return `${commonDir}\n${prefix}`;
}

// The checkout being analyzed (differs per worktree) — keys per-checkout state.
export function worktreeRoot(repo: string): string {
  if (!isGitRepo(repo)) return repo;
  return git(repo, ["rev-parse", "--show-toplevel"]).trim() || repo;
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
    return new Date(now.getTime() - n * days * MS_PER_DAY).toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(since)) return since;
  throw new GitError(`invalid --since "${since}" — expected e.g. "30d", "12w", "6m", "1y", or "YYYY-MM-DD"`);
}

const HALF_LIFE_DAYS = 90;

function weighted(ageDays: number): number {
  return Math.pow(0.5, Math.max(0, ageDays) / HALF_LIFE_DAYS);
}

// Raw numstat history — the cacheable form of churn. Scores are derived from
// it by summarizeChurn(), so a new HEAD only costs a `git log old..new` and a
// new day only costs dropping the commits that fell out of the window,
// instead of re-walking the whole window (seconds on a busy repo) every time.
export interface ChurnCommit {
  author_ts: number; // ms — recency weighting
  commit_ts: number; // ms — window membership (what git --since filters on)
  files: [path: string, added: number, deleted: number][];
}

export interface ChurnLog {
  head: string;
  since: string; // window start, YYYY-MM-DD (UTC midnight)
  commits: ChurnCommit[];
}

const windowStartMs = (sinceDate: string) => new Date(`${sinceDate}T00:00:00Z`).getTime();

function parseNumstatLog(out: string): ChurnCommit[] {
  const commits: ChurnCommit[] = [];
  let files = new Map<string, [string, number, number]>();
  const flush = () => {
    if (commits.length) commits[commits.length - 1].files = [...files.values()];
    files = new Map();
  };
  for (const line of out.split("\n")) {
    const header = line.match(/^@[0-9a-f]+\|(\d+)\|(\d+)$/);
    if (header) {
      flush();
      commits.push({
        author_ts: Number(header[1]) * MS_PER_SECOND,
        commit_ts: Number(header[2]) * MS_PER_SECOND,
        files: [],
      });
      continue;
    }
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m || !commits.length) continue;
    // A path can appear twice in one commit's numstat; it is still one commit.
    const entry = files.get(m[3]) ?? [m[3], 0, 0];
    if (m[1] !== "-") entry[1] += Number(m[1]);
    if (m[2] !== "-") entry[2] += Number(m[2]);
    files.set(m[3], entry);
  }
  flush();
  return commits;
}

function numstatLog(repo: string, sinceDate: string, range: string[]): ChurnCommit[] {
  try {
    return parseNumstatLog(
      git(repo, [
        "log",
        // Explicit UTC midnight: a bare date makes git fill in the CURRENT
        // time of day, so the same window measured different commits
        // depending on when in the day the analysis ran.
        `--since=${sinceDate}T00:00:00Z`,
        "--numstat",
        "--no-merges", // merge commits don't represent authored changes to a file
        "--no-renames",
        "--relative", // paths relative to the analyzed directory, like every other listing
        "--use-mailmap", // collapse an author's multiple committer identities
        // %H is hex, %at/%ct are digits — none can collide with the "|"
        // delimiter or a numstat line's own tab/path structure.
        "--format=@%H|%at|%ct",
        ...range,
      ]),
    );
  } catch (err) {
    throw new GitError(
      `git log failed for --since=${sinceDate} in ${repo}: ${(err as Error).message}`,
    );
  }
}

function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  try {
    git(repo, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false; // not an ancestor, or the old commit no longer exists (rewritten history)
  }
}

// prev: the log cached by an earlier run (any HEAD, any window), or null.
// Returns `prev` itself when it is still exact, so callers can skip the write.
export function churnLog(repo: string, since: string, prev: ChurnLog | null): ChurnLog {
  const sinceDate = sinceToDate(since); // validate the window even for non-repos
  if (!isGitRepo(repo)) return { head: "unknown", since: sinceDate, commits: [] };
  const head = headCommit(repo);
  if (prev && prev.head === head && prev.since === sinceDate) return prev;

  // The cached log can be extended only if it already covers this window's
  // start and its HEAD is still part of this history.
  const reusable = prev && prev.head !== "unknown" && prev.since <= sinceDate &&
    (prev.head === head || isAncestor(repo, prev.head, head));
  if (!reusable) return { head, since: sinceDate, commits: numstatLog(repo, sinceDate, []) };

  const start = windowStartMs(sinceDate);
  const fresh = prev.head === head ? [] : numstatLog(repo, sinceDate, [`${prev.head}..${head}`]);
  return {
    head,
    since: sinceDate,
    commits: [...fresh, ...prev.commits.filter((c) => c.commit_ts >= start)],
  };
}

// now: reference instant for recency weights and the trend midpoint. Callers
// pass the start of the current UTC day so repeat runs within a day (and the
// two sides of `entropy check`) score identically.
export function summarizeChurn(log: ChurnLog, now: number): Map<string, FileChurn> {
  const result = new Map<string, FileChurn>();
  const perFileTimestamps = new Map<string, number[]>();
  for (const commit of log.commits) {
    for (const [path, added, deleted] of commit.files) {
      const entry = result.get(path) ?? {
        commits: 0, lines_added: 0, lines_deleted: 0, weighted_commits: 0, trend: "stable" as const,
      };
      entry.commits++;
      entry.weighted_commits += weighted((now - commit.author_ts) / MS_PER_DAY);
      entry.lines_added += added;
      entry.lines_deleted += deleted;
      result.set(path, entry);
      const ts = perFileTimestamps.get(path) ?? [];
      ts.push(commit.author_ts);
      perFileTimestamps.set(path, ts);
    }
  }

  const midpoint = (windowStartMs(log.since) + now) / 2;
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

export function startOfUtcDay(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

export function churn(repo: string, since: string): Map<string, FileChurn> {
  return summarizeChurn(churnLog(repo, since, null), startOfUtcDay());
}

// --- comparing against a base commit (entropy check) ------------------------

// "auto": what this work would add on top of what is already shared — the
// fork point from the upstream branch if there is one, else from the default
// branch (remote, then local), else HEAD (uncommitted changes only).
const AUTO_BASES = ["@{upstream}", "origin/HEAD", "origin/main", "origin/master", "main", "master", "HEAD"];

export function resolveBase(repo: string, ref: string): string {
  if (!isGitRepo(repo)) throw new GitError(`${repo} is not a git repository — nothing to compare against`);
  const candidates = ref === "auto" ? AUTO_BASES : [ref];
  for (const candidate of candidates) {
    try {
      const sha = git(repo, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]).trim();
      if (!sha) continue;
      if (ref !== "auto" || candidate === "HEAD") return sha;
      return git(repo, ["merge-base", sha, "HEAD"]).trim() || sha;
    } catch {
      // unresolvable candidate (no upstream, no remote, unborn HEAD) — try the next
    }
  }
  throw new GitError(
    ref === "auto"
      ? `no commit to compare against in ${repo} (repository has no commits yet)`
      : `unknown base "${ref}" — expected a commit, branch or tag`,
  );
}

export interface ChangedFile {
  path: string;
  base_path: string | null; // null = did not exist at base; differs from path on rename
}

// Working tree (committed + staged + unstaged + untracked) versus `base`.
export function changedSince(repo: string, base: string): { changed: ChangedFile[]; deleted: string[] } {
  const fields = git(repo, ["diff", "--name-status", "-M", "-z", "--relative", base]).split("\0");
  const changed: ChangedFile[] = [];
  const deleted: string[] = [];
  for (let i = 0; i + 1 < fields.length; ) {
    const status = fields[i++];
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = fields[i++];
      const to = fields[i++];
      changed.push({ path: to, base_path: from });
      if (status.startsWith("R")) deleted.push(from);
    } else {
      const path = fields[i++];
      if (status.startsWith("D")) deleted.push(path);
      else changed.push({ path, base_path: status.startsWith("A") ? null : path });
    }
  }
  const untracked = git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const path of untracked.split("\0").filter(Boolean)) changed.push({ path, base_path: null });
  return { changed, deleted };
}

export type LineChanges =
  | { kind: "new-file" }
  | { kind: "diff"; added: Set<number>; removedAfter: Set<number> };

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const hunkCount = (raw: string | undefined) => (raw === undefined ? 1 : Number(raw));
const isBlankChange = (patchLine: string) => !patchLine.slice(1).trim();

export function parseZeroContextPatch(patch: string): LineChanges {
  const added = new Set<number>();
  const removedAfter = new Set<number>();
  const lines = patch.split("\n");
  let ln = 0;
  while (ln < lines.length) {
    const hunk = HUNK_HEADER.exec(lines[ln++]);
    if (!hunk) continue;
    let afterLine = Number(hunk[2]);
    let removesCode = false;
    let bodyLines = hunkCount(hunk[1]) + hunkCount(hunk[3]);
    for (; bodyLines > 0 && ln < lines.length; ln++) {
      const body = lines[ln];
      if (body.startsWith("\\")) continue;
      bodyLines--;
      if (body.startsWith("+") && !isBlankChange(body)) added.add(afterLine);
      if (body.startsWith("+")) afterLine++;
      if (body.startsWith("-") && !isBlankChange(body)) removesCode = true;
    }
    if (removesCode && hunkCount(hunk[3]) === 0) removedAfter.add(Number(hunk[2]));
  }
  return { kind: "diff", added, removedAfter };
}

export function changedLines(repo: string, base: string, change: ChangedFile): LineChanges {
  if (change.base_path === null) return { kind: "new-file" };
  const pathspecs = [...new Set([change.base_path, change.path])].map((p) => `:(literal)${p}`);
  return parseZeroContextPatch(
    git(repo, ["diff", "-U0", "-M", "--no-color", "--no-ext-diff", base, "--", ...pathspecs]),
  );
}

export function listFilesAt(repo: string, commit: string): string[] {
  return git(repo, ["ls-tree", "-r", "--name-only", "-z", commit]).split("\0").filter(Boolean);
}

// One `git cat-file --batch` for all paths. Missing or non-UTF8-safe blobs
// are simply absent from the result.
export function readFilesAt(repo: string, commit: string, paths: string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (!paths.length) return result;
  const out = execFileSync("git", ["-C", repo, "cat-file", "--batch"], {
    input: paths.map((p) => `${commit}:./${p}\n`).join(""),
    maxBuffer: MAX_GIT_LOG_BYTES,
  });
  let offset = 0;
  for (const path of paths) {
    const eol = out.indexOf(0x0a, offset);
    if (eol === -1) break;
    const header = out.toString("utf8", offset, eol);
    offset = eol + 1;
    const object = header.match(/^[0-9a-f]+ (\w+) (\d+)$/);
    if (!object) continue; // "<name> missing": no payload follows
    const size = Number(object[2]);
    if (object[1] === "blob") result.set(path, out.toString("utf8", offset, offset + size));
    offset += size + 1; // payload + trailing newline
  }
  return result;
}
