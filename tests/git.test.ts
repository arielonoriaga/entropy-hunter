import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { churn, currentCommit, GitError, isGitRepo, sinceToDate } from "../src/git";

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
