import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { churn, currentCommit, isGitRepo, sinceToDate } from "../src/git";

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
});
