import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
    const result = analyzeRepo(FIXTURES, DEFAULT_CONFIG);

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
