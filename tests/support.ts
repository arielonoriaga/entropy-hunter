import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// A throwaway git repository for tests that need real history.
export interface TempRepo {
  path: string;
  write(file: string, content: string): void;
  git(...args: string[]): string;
  commit(message: string, date?: string): string; // returns the new commit's hash
}

export function tempRepo(prefix = "entropy-repo-"): TempRepo {
  const path = mkdtempSync(join(tmpdir(), prefix));
  const run = (args: string[], date?: string) => {
    const when = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
    const result = spawnSync(
      "git",
      ["-C", path, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
      { encoding: "utf8", env: { ...process.env, ...when } },
    );
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  run(["init", "-q", "-b", "main"]);
  return {
    path,
    write(file, content) {
      mkdirSync(dirname(join(path, file)), { recursive: true });
      writeFileSync(join(path, file), content);
    },
    git: (...args) => run(args),
    commit(message, date) {
      run(["add", "-A"]);
      run(["commit", "-qm", message], date);
      return run(["rev-parse", "HEAD"]);
    },
  };
}

// A function whose cyclomatic complexity is about `branches + 1`.
export function branchy(name: string, branches: number): string {
  const body = Array.from({ length: branches }, (_, i) => `  if (x === ${i + 10}) return ${i + 10};`).join("\n");
  return `export function ${name}(x: number): number {\n${body}\n  return x;\n}\n`;
}
