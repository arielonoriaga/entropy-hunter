import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const FIXTURES = join(import.meta.dir, "..", "fixtures");

async function run(args: string[]) {
  const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
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
    expect(parsed.version).toBe(8);
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
});
