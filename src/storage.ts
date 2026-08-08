import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AnalysisResult, FileMetrics } from "./types";

export interface SnapshotRow {
  id: number;
  repository: string;
  commit_hash: string;
  timestamp: string;
  entropy: number;
  complexity: number;
  coupling: number;
  churn: number;
  duplication: number;
  files_analyzed: number;
}

export class Storage {
  db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repository TEXT NOT NULL,
        commit_hash TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        entropy REAL NOT NULL,
        complexity REAL NOT NULL,
        coupling REAL NOT NULL,
        churn REAL NOT NULL,
        duplication REAL NOT NULL,
        files_analyzed INTEGER NOT NULL,
        report_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS file_metrics (
        snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
        path TEXT NOT NULL,
        language TEXT NOT NULL,
        loc INTEGER, complexity_total INTEGER, complexity_average REAL,
        complexity_max INTEGER, fan_in INTEGER, fan_out INTEGER,
        dependency_count INTEGER, dependent_count INTEGER,
        commits INTEGER, lines_added INTEGER, lines_deleted INTEGER,
        duplicated_lines INTEGER, duplicated_blocks INTEGER,
        duplication_percentage REAL,
        complexity_score REAL, coupling_score REAL, churn_score REAL,
        duplication_score REAL, hotspot_score REAL, entropy_contribution REAL
      );
      CREATE INDEX IF NOT EXISTS idx_fm_snapshot ON file_metrics(snapshot_id);
      CREATE INDEX IF NOT EXISTS idx_fm_path ON file_metrics(path);
      CREATE TABLE IF NOT EXISTS file_cache (
        path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        fileset_hash TEXT NOT NULL,
        base_json TEXT NOT NULL,
        deps_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    // Additive migrations for DBs created before the state signal (v2).
    for (const ddl of [
      "ALTER TABLE snapshots ADD COLUMN state REAL NOT NULL DEFAULT 0",
      "ALTER TABLE file_metrics ADD COLUMN type_count INTEGER",
      "ALTER TABLE file_metrics ADD COLUMN optional_fields INTEGER",
      "ALTER TABLE file_metrics ADD COLUMN boolean_fields INTEGER",
      "ALTER TABLE file_metrics ADD COLUMN max_state_fields INTEGER",
      "ALTER TABLE file_metrics ADD COLUMN state_score REAL",
      "ALTER TABLE snapshots ADD COLUMN clumping REAL NOT NULL DEFAULT 0",
      "ALTER TABLE file_metrics ADD COLUMN data_clumps INTEGER",
      "ALTER TABLE file_metrics ADD COLUMN max_clump_fields INTEGER",
      "ALTER TABLE file_metrics ADD COLUMN clump_prefix TEXT",
      "ALTER TABLE file_metrics ADD COLUMN clumping_score REAL",
      "ALTER TABLE snapshots ADD COLUMN deadcode REAL NOT NULL DEFAULT 0",
      "ALTER TABLE snapshots ADD COLUMN architecture REAL NOT NULL DEFAULT 0",
      "ALTER TABLE snapshots ADD COLUMN reach REAL NOT NULL DEFAULT 0",
      "ALTER TABLE file_metrics ADD COLUMN is_orphan INTEGER",
      "ALTER TABLE file_metrics ADD COLUMN transitive_dependents INTEGER",
      "ALTER TABLE file_metrics ADD COLUMN arch_violations INTEGER",
      "ALTER TABLE file_metrics ADD COLUMN deadcode_score REAL",
      "ALTER TABLE file_metrics ADD COLUMN architecture_score REAL",
      "ALTER TABLE file_metrics ADD COLUMN reach_score REAL",
      "ALTER TABLE snapshots ADD COLUMN magic REAL NOT NULL DEFAULT 0",
      "ALTER TABLE file_metrics ADD COLUMN magic_numbers INTEGER",
      "ALTER TABLE file_metrics ADD COLUMN magic_strings INTEGER",
      "ALTER TABLE file_metrics ADD COLUMN magic_score REAL",
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        /* column already exists */
      }
    }
  }

  // --- incremental analysis cache -----------------------------------------
  // base_json (complexity, loc, duplication fingerprint) depends only on file
  // content; deps_json also depends on the repo file list, since relative
  // imports resolve against it — hence the separate fileset_hash guard.

  getFileCache(path: string) {
    return this.db
      .query("SELECT content_hash, fileset_hash, base_json, deps_json FROM file_cache WHERE path = ?")
      .get(path) as
      | { content_hash: string; fileset_hash: string; base_json: string; deps_json: string }
      | null;
  }

  putFileCaches(
    rows: { path: string; content_hash: string; fileset_hash: string; base_json: string; deps_json: string }[],
  ) {
    const stmt = this.db.query(
      `INSERT INTO file_cache (path, content_hash, fileset_hash, base_json, deps_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET content_hash = excluded.content_hash,
         fileset_hash = excluded.fileset_hash, base_json = excluded.base_json,
         deps_json = excluded.deps_json`,
    );
    this.db.transaction(() => {
      for (const r of rows) stmt.run(r.path, r.content_hash, r.fileset_hash, r.base_json, r.deps_json);
    })();
  }

  kvGet(key: string): string | null {
    const row = this.db.query("SELECT value FROM kv_cache WHERE key = ?").get(key) as
      | { value: string }
      | null;
    return row?.value ?? null;
  }

  kvSet(key: string, value: string) {
    this.db
      .query("INSERT INTO kv_cache (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  hasSnapshotFor(commit: string): boolean {
    return !!this.db
      .query("SELECT 1 FROM snapshots WHERE commit_hash = ? LIMIT 1")
      .get(commit);
  }

  saveSnapshot(result: AnalysisResult): number {
    const insert = this.db.query(`
      INSERT INTO snapshots (repository, commit_hash, timestamp, entropy,
        complexity, coupling, churn, duplication, state, clumping, deadcode,
        architecture, reach, magic, files_analyzed, report_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `);
    const { summary: s } = result;
    // Persist the full report minus per-function detail (keeps DB small; a
    // future agent gets functions from a fresh `entropy file` call).
    const slim = {
      ...result,
      files: result.files.map(({ functions, dependencies, dependents, ...rest }) => rest),
      hotspots: result.hotspots.map((h) => h.path),
    };
    const row = insert.get(
      result.repository.name, result.repository.commit, result.timestamp,
      s.entropy, s.complexity, s.coupling, s.churn, s.duplication, s.state,
      s.clumping, s.deadcode, s.architecture, s.reach, s.magic,
      result.files_analyzed, JSON.stringify(slim),
    ) as { id: number };

    // Named columns: migrated DBs append new columns at the end, so
    // positional inserts would misalign between fresh and migrated schemas.
    const fm = this.db.query(`
      INSERT INTO file_metrics (snapshot_id, path, language, loc,
        complexity_total, complexity_average, complexity_max, fan_in, fan_out,
        dependency_count, dependent_count, commits, lines_added, lines_deleted,
        duplicated_lines, duplicated_blocks, duplication_percentage,
        complexity_score, coupling_score, churn_score, duplication_score,
        hotspot_score, entropy_contribution, type_count, optional_fields,
        boolean_fields, max_state_fields, state_score, data_clumps,
        max_clump_fields, clump_prefix, clumping_score, is_orphan,
        transitive_dependents, arch_violations, deadcode_score,
        architecture_score, reach_score, magic_numbers, magic_strings, magic_score)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const tx = this.db.transaction((files: FileMetrics[]) => {
      for (const f of files) {
        fm.run(
          row.id, f.path, f.language, f.loc, f.complexity_total,
          f.complexity_average, f.complexity_max, f.fan_in, f.fan_out,
          f.dependency_count, f.dependent_count, f.commits, f.lines_added,
          f.lines_deleted, f.duplicated_lines, f.duplicated_blocks,
          f.duplication_percentage, f.complexity_score, f.coupling_score,
          f.churn_score, f.duplication_score, f.hotspot_score,
          f.entropy_contribution, f.type_count, f.optional_fields,
          f.boolean_fields, f.max_state_fields, f.state_score, f.data_clumps,
          f.max_clump_fields, f.clump_prefix, f.clumping_score,
          f.is_orphan ? 1 : 0, f.transitive_dependents, f.arch_violations,
          f.deadcode_score, f.architecture_score, f.reach_score,
          f.magic_numbers, f.magic_strings, f.magic_score,
        );
      }
    });
    tx(result.files);
    return row.id;
  }

  history(opts: { limit?: number; sinceDate?: string } = {}): SnapshotRow[] {
    const rows = this.db
      .query(
        `SELECT id, repository, commit_hash, timestamp, entropy, complexity,
                coupling, churn, duplication, files_analyzed
         FROM snapshots
         WHERE (? IS NULL OR timestamp >= ?)
         ORDER BY timestamp ASC, id ASC`,
      )
      .all(opts.sinceDate ?? null, opts.sinceDate ?? null) as SnapshotRow[];
    return opts.limit ? rows.slice(-opts.limit) : rows;
  }

  latest(): SnapshotRow | null {
    return (this.db
      .query(
        `SELECT id, repository, commit_hash, timestamp, entropy, complexity,
                coupling, churn, duplication, files_analyzed
         FROM snapshots ORDER BY timestamp DESC, id DESC LIMIT 1`,
      )
      .get() as SnapshotRow) ?? null;
  }

  close() {
    this.db.close();
  }
}

// delta between consecutive snapshots; velocity = entropy points per day.
export function withDeltas(rows: SnapshotRow[]) {
  return rows.map((row, i) => {
    if (i === 0) return { ...row, delta: null as number | null, velocity: null as number | null };
    const prev = rows[i - 1];
    const delta = Math.round((row.entropy - prev.entropy) * 10) / 10;
    const days =
      (new Date(row.timestamp).getTime() - new Date(prev.timestamp).getTime()) / 86400_000;
    const velocity = days > 0 ? Math.round((delta / days) * 100) / 100 : null;
    return { ...row, delta, velocity };
  });
}
