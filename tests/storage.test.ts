import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeRepo } from "../src/analyze";
import { Storage, withDeltas } from "../src/storage";
import { DEFAULT_CONFIG } from "../src/types";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
let dir: string;

beforeAll(() => (dir = mkdtempSync(join(tmpdir(), "entropy-db-"))));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("snapshot persistence", () => {
  test("save, dedupe by commit, read back history with deltas", () => {
    const db = join(dir, "entropy.db");
    const storage = new Storage(db);
    const result = analyzeRepo(FIXTURES, DEFAULT_CONFIG, DEFAULT_CONFIG.analysis.since, null, null);

    result.repository.commit = "aaa1111";
    result.timestamp = "2026-07-01T00:00:00.000Z";
    const id1 = storage.saveSnapshot(result);
    expect(id1).toBeGreaterThan(0);
    expect(storage.hasSnapshotFor("aaa1111")).toBe(true);
    expect(storage.hasSnapshotFor("bbb2222")).toBe(false);

    const bumped = {
      ...result,
      repository: { ...result.repository, commit: "bbb2222" },
      timestamp: "2026-07-11T00:00:00.000Z",
      summary: { ...result.summary, entropy: result.summary.entropy + 5 },
    };
    storage.saveSnapshot(bumped);

    const rows = storage.history();
    expect(rows.length).toBe(2);
    expect(rows[0].commit_hash).toBe("aaa1111");

    const withD = withDeltas(rows);
    expect(withD[0].delta).toBeNull();
    expect(withD[1].delta).toBeCloseTo(5, 1);
    expect(withD[1].velocity).toBeCloseTo(0.5, 2); // +5 over 10 days

    expect(storage.latest()!.commit_hash).toBe("bbb2222");

    // per-file metrics persisted
    const count = storage.db
      .query("SELECT COUNT(*) AS n FROM file_metrics WHERE snapshot_id = ?")
      .get(id1) as { n: number };
    expect(count.n).toBe(result.files_analyzed);

    // history --limit and --since filters
    expect(storage.history({ limit: 1 }).map((r) => r.commit_hash)).toEqual(["bbb2222"]);
    expect(storage.history({ sinceDate: "2026-07-05" }).length).toBe(1);

    storage.close();

    // reopen: data survives
    const reopened = new Storage(db);
    expect(reopened.history().length).toBe(2);
    reopened.close();
  });
});

describe("incremental cache", () => {
  test("warm cached run equals cold uncached run", () => {
    const storage = new Storage(join(dir, "cache.db"));
    const uncached = analyzeRepo(FIXTURES, DEFAULT_CONFIG, DEFAULT_CONFIG.analysis.since, null, null);
    const cold = analyzeRepo(FIXTURES, DEFAULT_CONFIG, DEFAULT_CONFIG.analysis.since, storage, null); // populates cache
    const warm = analyzeRepo(FIXTURES, DEFAULT_CONFIG, DEFAULT_CONFIG.analysis.since, storage, null); // reads cache
    const strip = (r: ReturnType<typeof analyzeRepo>) => ({ ...r, timestamp: null });
    expect(strip(cold)).toEqual(strip(uncached));
    expect(strip(warm)).toEqual(strip(uncached));
    // cache actually populated, one row per analyzed file
    const n = storage.db.query("SELECT COUNT(*) AS n FROM file_cache").get() as { n: number };
    expect(n.n).toBe(uncached.files_analyzed);
    storage.close();
  });

  test("editing a file's content invalidates its cache entry", () => {
    const repo = mkdtempSync(join(tmpdir(), "entropy-repo-"));
    cpSync(FIXTURES, repo, { recursive: true });
    const target = join(repo, "typescript", "simple", "util.ts");

    const storage = new Storage(join(dir, "cache-invalidate.db"));
    const before = analyzeRepo(repo, DEFAULT_CONFIG, DEFAULT_CONFIG.analysis.since, storage, null);
    const beforeRow = storage.getFileCache("typescript/simple/util.ts")!;

    writeFileSync(
      target,
      "export function extra(a: number, b: number): number {\n" +
        "  if (a > b) { return a; } else if (a < b) { return b; } else { return 0; }\n" +
        "}\n",
      { flag: "a" },
    );

    const after = analyzeRepo(repo, DEFAULT_CONFIG, DEFAULT_CONFIG.analysis.since, storage, null);
    const afterRow = storage.getFileCache("typescript/simple/util.ts")!;
    const directUncached = analyzeRepo(repo, DEFAULT_CONFIG, DEFAULT_CONFIG.analysis.since, null, null);

    expect(afterRow.content_hash).not.toBe(beforeRow.content_hash);
    const beforeFile = before.files.find((f) => f.path === "typescript/simple/util.ts")!;
    const afterFile = after.files.find((f) => f.path === "typescript/simple/util.ts")!;
    const directFile = directUncached.files.find((f) => f.path === "typescript/simple/util.ts")!;
    expect(afterFile.loc).toBeGreaterThan(beforeFile.loc);
    expect(afterFile.complexity_total).toBeGreaterThan(beforeFile.complexity_total);
    expect(afterFile.loc).toBe(directFile.loc);
    expect(afterFile.complexity_total).toBe(directFile.complexity_total);

    storage.close();
    rmSync(repo, { recursive: true, force: true });
  });

  test("adding a file that changes the fileset invalidates dependency cache without touching unrelated content hashes", () => {
    const repo = mkdtempSync(join(tmpdir(), "entropy-repo-"));
    cpSync(FIXTURES, repo, { recursive: true });

    const storage = new Storage(join(dir, "cache-fileset.db"));
    analyzeRepo(repo, DEFAULT_CONFIG, DEFAULT_CONFIG.analysis.since, storage, null);
    const sharedBefore = storage.getFileCache("typescript/coupled/shared.ts")!;

    // New file that imports shared.ts, changing shared.ts's fan_in once resolved.
    writeFileSync(
      join(repo, "typescript", "coupled", "extra.ts"),
      'import { log } from "./shared";\nexport function useLog(): void { log("x"); }\n',
    );

    const after = analyzeRepo(repo, DEFAULT_CONFIG, DEFAULT_CONFIG.analysis.since, storage, null);
    const sharedAfter = storage.getFileCache("typescript/coupled/shared.ts")!;
    const directUncached = analyzeRepo(repo, DEFAULT_CONFIG, DEFAULT_CONFIG.analysis.since, null, null);

    // content unchanged → same content_hash, but fileset_hash must have moved
    expect(sharedAfter.content_hash).toBe(sharedBefore.content_hash);
    expect(sharedAfter.fileset_hash).not.toBe(sharedBefore.fileset_hash);

    const sharedFile = after.files.find((f) => f.path === "typescript/coupled/shared.ts")!;
    const directShared = directUncached.files.find((f) => f.path === "typescript/coupled/shared.ts")!;
    expect(sharedFile.fan_in).toBe(directShared.fan_in);

    storage.close();
    rmSync(repo, { recursive: true, force: true });
  });
});
