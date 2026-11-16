import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { branchy, tempRepo } from "./support";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const FIXTURES = join(import.meta.dir, "..", "fixtures");

// The CLI's incremental cache goes to a throwaway directory, never the user's.
const CACHE = mkdtempSync(join(tmpdir(), "entropy-cli-cache-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

async function run(args: string[], cwd?: string) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe", stderr: "pipe", cwd,
    env: { ...process.env, ENTROPY_CACHE_DIR: CACHE },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

// These spawn the real binary — this is the trust boundary other agents
// (the reduce-entropy skill, or any CLI-shelling consumer) actually cross.
// Library-level tests elsewhere don't cover exit codes or stdout shape.
describe("entropy CLI (end-to-end)", () => {
  test("analyze --format json on a real repo: exit 0, stdout is valid schema JSON", async () => {
    const { stdout, exitCode, stderr } = await run(["report", "--repo", FIXTURES, "--format", "json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.version).toBe(13);
    expect(typeof parsed.summary.entropy).toBe("number");
    expect(stderr).toBe(""); // no progress noise on a non-TTY pipe
  });

  test("unknown command exits non-zero with a usage message on stderr", async () => {
    const { exitCode, stderr } = await run(["bogus-command"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command");
  });

  test("file <path-not-analyzed> exits non-zero with a clear message", async () => {
    const { exitCode, stderr } = await run(["file", "--repo", FIXTURES, "does/not/exist.ts"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Not an analyzed file");
  });

  test("--limit abc is rejected (used to silently render zero rows)", async () => {
    const { exitCode, stderr } = await run(["hotspots", "--repo", FIXTURES, "--limit", "abc"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("--limit must be a positive integer");
  });

  test("--limit -5 is rejected", async () => {
    const { exitCode, stderr } = await run(["hotspots", "--repo", FIXTURES, "--limit", "-5"]);
    expect(exitCode).toBe(2);
  });

  test("--format garbage is rejected instead of silently falling back to text", async () => {
    const { exitCode, stderr } = await run(["report", "--repo", FIXTURES, "--format", "yaml"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("--format must be one of");
  });

  test("malformed --since fails loudly instead of silently returning zero churn", async () => {
    const { exitCode, stderr } = await run(["analyze", "--repo", FIXTURES, "--since", "banana"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("since");
  });

  test("no command prints usage and exits 0", async () => {
    const { exitCode, stdout } = await run([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: entropy");
  });

  test("hotspots --format json on a real repo returns a JSON array with why-strings", async () => {
    const { stdout, exitCode } = await run(["hotspots", "--repo", FIXTURES, "--format", "json", "--limit", "3"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeLessThanOrEqual(3);
    if (parsed.length) expect(typeof parsed[0].why).toBe("string");
  });

  test("priority --format json on a real repo returns files sorted by priority_score desc", async () => {
    const { stdout, exitCode } = await run(["priority", "--repo", FIXTURES, "--format", "json", "--limit", "3"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeLessThanOrEqual(3);
    const scores = parsed.map((f: any) => f.priority_score);
    expect(scores).toEqual([...scores].sort((a: number, b: number) => b - a));
  });

  test("priority (text) renders a REFACTOR PRIORITY box", async () => {
    const { stdout, exitCode } = await run(["priority", "--repo", FIXTURES]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("REFACTOR PRIORITY");
  });

  test("health --format json on a real repo returns the four topline bands", async () => {
    const { stdout, exitCode } = await run(["health", "--repo", FIXTURES, "--format", "json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    for (const k of ["entropy", "p95", "critical", "trend"]) {
      expect(typeof parsed[k].status).toBe("string");
    }
    expect(Array.isArray(parsed.attention)).toBe(true);
    expect(Array.isArray(parsed.recommendations)).toBe(true);
  });

  test("health (text) renders REPOSITORY HEALTH", async () => {
    const { stdout, exitCode } = await run(["health", "--repo", FIXTURES]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("REPOSITORY HEALTH");
  });

  test("a report larger than the pipe buffer arrives whole", async () => {
    // console.log on a pipe used to lose everything past 64 KiB.
    const { stdout, exitCode } = await run(["report", "--repo", join(import.meta.dir, ".."), "--format", "json"]);
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(65536);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  test("zoom lists modules; zoom <path> prints the ladder; unknown path exits 1", async () => {
    const modules = await run(["zoom", "--repo", FIXTURES, "--format", "json"]);
    expect(JSON.parse(modules.stdout).map((m: any) => m.path)).toContain("typescript/coupled");
    const ladder = await run(["zoom", "--repo", FIXTURES, "typescript/coupled/payments.ts"]);
    expect(ladder.stdout).toContain("ZOOM typescript/coupled/payments.ts");
    const missing = await run(["zoom", "--repo", FIXTURES, "nope"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("Not an analyzed file or directory");
  });

  test("the cache lives outside the repository", async () => {
    await run(["health", "--repo", FIXTURES]);
    expect(readdirSync(CACHE).some((f) => f.endsWith(".db"))).toBe(true);
    expect(existsSync(join(FIXTURES, ".entropy"))).toBe(false);
  });
});

describe("entropy check (end-to-end)", () => {
  test("exit 0 on a clean tree, exit 1 with the finding on a regression, exit 0 once accepted", async () => {
    const repo = tempRepo("entropy-cli-check-");
    repo.write("src/pricing.ts", branchy("price", 3));
    repo.commit("base");
    const clean = await run(["check", "--repo", repo.path]);
    expect(clean.exitCode).toBe(0);
    expect(clean.stdout).toContain("PASS");

    repo.write("src/pricing.ts", branchy("price", 20));
    const failed = await run(["check", "--repo", repo.path, "--format", "json"]);
    expect(failed.exitCode).toBe(1);
    const parsed = JSON.parse(failed.stdout);
    expect(parsed.verdict).toBe("fail");
    expect(parsed.files[0].findings[0]).toMatchObject({ rule: "complexity", level: "fail" });

    const noReason = await run(["check", "--repo", repo.path, "--accept", "src/pricing.ts"]);
    expect(noReason.exitCode).toBe(2);
    expect(noReason.stderr).toContain("--reason");

    const accepted = await run(["check", "--repo", repo.path, "--accept", "src/pricing.ts", "--reason", "lookup table"]);
    expect(accepted.exitCode).toBe(0);
    expect(accepted.stdout).toContain("accepted: lookup table");
    rmSync(repo.path, { recursive: true, force: true });
  });

  test("outside a git repository it is a clear error (exit 2), not a pass", async () => {
    const dir = mkdtempSync(join(tmpdir(), "entropy-nogit-"));
    const { exitCode, stderr } = await run(["check", "--repo", dir]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("not a git repository");
    rmSync(dir, { recursive: true, force: true });
  });
});
