import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedSince, churn, churnLog, currentCommit, GitError, isGitRepo, readFilesAt, resolveBase,
  sinceToDate, startOfUtcDay, summarizeChurn,
} from "../src/git";
import { tempRepo } from "./support";

let repo: string;

function sh(args: string[], date?: string) {
  execFileSync("git", ["-C", repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "entropy-git-"));
  sh(["init", "-q"]);
  // First commit deliberately old — window tests rely on it.
  writeFileSync(join(repo, "a.ts"), "line1\nline2\nline3\n");
  sh(["add", "."]);
  sh(["commit", "-qm", "first"], "2020-01-01T12:00:00Z");
  writeFileSync(join(repo, "a.ts"), "line1\nCHANGED\nline3\nline4\n");
  writeFileSync(join(repo, "b.ts"), "new file\n");
  sh(["add", "."]);
  sh(["commit", "-qm", "second"]);
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("git churn", () => {
  test("counts commits, additions and deletions per file", () => {
    const map = churn(repo, "2019-01-01");
    const a = map.get("a.ts")!;
    expect(a.commits).toBe(2);
    expect(a.lines_added).toBe(5); // 3 initial + 2 in second commit
    expect(a.lines_deleted).toBe(1);
    const b = map.get("b.ts")!;
    expect(b.commits).toBe(1);
    expect(b.lines_added).toBe(1);
  });

  test("since window excludes commits older than the window", () => {
    const recent = churn(repo, "7d"); // only the second commit qualifies
    expect(recent.get("a.ts")!.commits).toBe(1);
    expect(recent.get("a.ts")!.lines_added).toBe(2);
    expect(recent.get("b.ts")!.commits).toBe(1);
  });

  test("helpers", () => {
    expect(isGitRepo(repo)).toBe(true);
    expect(currentCommit(repo)).toMatch(/^[0-9a-f]{7,}$/);
    const now = new Date("2026-08-07T00:00:00Z");
    expect(sinceToDate("30d", now)).toBe("2026-07-08");
    expect(sinceToDate("2026-01-01", now)).toBe("2026-01-01");
  });

  test("malformed --since fails loudly instead of silently returning empty churn", () => {
    expect(() => sinceToDate("thirty days")).toThrow(GitError);
    expect(() => sinceToDate("0d")).toThrow(GitError);
    expect(() => churn(repo, "not-a-window")).toThrow(GitError);
  });

  test("a non-repo path degrades to empty churn (not a repo is a legitimate state)", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "entropy-notgit-"));
    expect(churn(notARepo, "30d")).toEqual(new Map());
    // but a malformed --since is still validated even for a non-repo
    expect(() => churn(notARepo, "not-a-window")).toThrow(GitError);
    rmSync(notARepo, { recursive: true, force: true });
  });

  test("weighted_commits decays with age; recent-only history trends accelerating", () => {
    const recent = churn(repo, "7d").get("a.ts")!;
    expect(recent.weighted_commits).toBeGreaterThan(0);
    expect(recent.weighted_commits).toBeLessThanOrEqual(recent.commits);
    expect(["accelerating", "stable", "cooling"]).toContain(recent.trend);
  });

  test("merge commits are excluded from churn (--no-merges)", () => {
    const base = execFileSync("git", ["-C", repo, "symbolic-ref", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
    sh(["checkout", "-qb", "feature"]);
    writeFileSync(join(repo, "c.ts"), "feature file\n");
    sh(["add", "."]);
    sh(["commit", "-qm", "feature commit"]);
    sh(["checkout", "-q", base]);
    // merge --no-ff always creates a real merge commit with no diff of its own
    execFileSync("git", ["-C", repo, "merge", "--no-ff", "-q", "-m", "merge feature", "feature"], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
      },
    });
    const map = churn(repo, "2019-01-01");
    // c.ts got exactly 1 real commit; the merge commit must not inflate it
    expect(map.get("c.ts")!.commits).toBe(1);
  });
});

describe("incremental churn log", () => {
  test("extending a cached log with new commits equals recomputing from scratch", () => {
    const r = tempRepo("entropy-churnlog-");
    r.write("a.ts", "one\n");
    r.commit("first");
    const cached = churnLog(r.path, "30d", null);
    r.write("a.ts", "one\ntwo\n");
    r.write("b.ts", "new\n");
    r.commit("second");

    const extended = churnLog(r.path, "30d", cached);
    const fresh = churnLog(r.path, "30d", null);
    const now = startOfUtcDay();
    expect(extended.commits.length).toBe(2);
    expect(summarizeChurn(extended, now)).toEqual(summarizeChurn(fresh, now));
    expect(summarizeChurn(extended, now).get("a.ts")).toMatchObject({ commits: 2, lines_added: 2 });
    rmSync(r.path, { recursive: true, force: true });
  });

  test("an unchanged HEAD and window reuses the cached log as is", () => {
    const cached = churnLog(repo, "2019-01-01", null);
    expect(churnLog(repo, "2019-01-01", cached)).toBe(cached);
  });

  test("a later window start only drops the commits that fell out of it", () => {
    const wide = churnLog(repo, "2019-01-01", null); // includes the 2020 commit
    const narrow = churnLog(repo, "7d", wide);
    // Only the 2020 commit is older than a week.
    expect(narrow.commits.length).toBe(wide.commits.length - 1);
    expect(narrow.commits.every((c) => c.commit_ts > Date.now() - 8 * 86_400_000)).toBe(true);
  });

  test("a cached log from unrelated history is discarded, not merged", () => {
    const stale = { head: "0".repeat(40), since: "2019-01-01", commits: [{ author_ts: 1, commit_ts: 9e15, files: [["ghost.ts", 9, 9] as [string, number, number]] }] };
    const log = churnLog(repo, "2019-01-01", stale);
    expect(summarizeChurn(log, startOfUtcDay()).has("ghost.ts")).toBe(false);
  });

  test("the window starts at UTC midnight regardless of the time of day", () => {
    // A bare date makes git fill in the current time, silently dropping
    // commits made earlier on the window's first day.
    const r = tempRepo("entropy-window-");
    r.write("a.ts", "x\n");
    r.commit("early that day", "2024-03-10T00:00:30Z");
    expect(churnLog(r.path, "2024-03-10", null).commits.length).toBe(1);
    rmSync(r.path, { recursive: true, force: true });
  });
});

describe("comparing against a base commit", () => {
  test("changedSince reports modified, added, untracked, renamed and deleted files", () => {
    const r = tempRepo("entropy-diff-");
    r.write("keep.ts", "export const keep = 1;\n");
    r.write("old-name.ts", "export const stable = 'a long enough line to be recognized as the same file';\n");
    r.write("gone.ts", "export const gone = 1;\n");
    const base = r.commit("base");
    r.write("keep.ts", "export const keep = 2;\n");
    r.git("mv", "old-name.ts", "new-name.ts");
    r.git("rm", "-q", "gone.ts");
    r.write("staged.ts", "export const staged = 1;\n");
    r.git("add", "staged.ts");
    r.write("untracked.ts", "export const untracked = 1;\n");

    const { changed, deleted } = changedSince(r.path, base);
    const byPath = Object.fromEntries(changed.map((c) => [c.path, c.base_path]));
    expect(byPath).toEqual({
      "keep.ts": "keep.ts", "new-name.ts": "old-name.ts", "staged.ts": null, "untracked.ts": null,
    });
    expect(deleted.sort()).toEqual(["gone.ts", "old-name.ts"]);
    expect(readFilesAt(r.path, base, ["keep.ts", "missing.ts", "gone.ts"])).toEqual(
      new Map([["keep.ts", "export const keep = 1;\n"], ["gone.ts", "export const gone = 1;\n"]]),
    );
    rmSync(r.path, { recursive: true, force: true });
  });

  test("auto base: fork point from the default branch on a feature branch, HEAD on the default branch itself", () => {
    const r = tempRepo("entropy-base-");
    r.write("a.ts", "export const a = 1;\n");
    const fork = r.commit("on main");
    expect(resolveBase(r.path, "auto")).toBe(fork); // on main, nothing upstream: HEAD
    r.git("checkout", "-q", "-b", "feature");
    r.write("a.ts", "export const a = 2;\n");
    const tip = r.commit("on feature");
    expect(resolveBase(r.path, "auto")).toBe(fork); // committed branch work is still in scope
    expect(resolveBase(r.path, "HEAD")).toBe(tip);
    expect(() => resolveBase(r.path, "no-such-ref")).toThrow(GitError);
    rmSync(r.path, { recursive: true, force: true });
  });
});
