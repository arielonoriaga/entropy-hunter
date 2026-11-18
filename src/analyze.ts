import { existsSync } from "node:fs";
import {
  FREE_NESTING, SIGNALS, type AnalysisResult, type EntropyConfig, type FileFacts, type FileMetrics,
  type ArchViolation, type Signal, type Summary,
} from "./types";
import { loadAliases } from "./aliases";
import { analyzerFor } from "./languages";
import { countNonBlankLines } from "./languages/strip";
import {
  churnLog, currentCommit, repoName, startOfUtcDay, summarizeChurn, worktreeRoot,
  type ChurnLog, type FileChurn,
} from "./git";
import { detectDuplication, fingerprint, type FileFingerprint } from "./duplication";
import { bitmask, transitiveReach } from "./graph";
import type { Storage } from "./storage";
import { workingTree, type SourceTree } from "./tree";
import {
  isTestFile, type ComplexityResult, type LanguageAnalyzer, type Nesting,
} from "./languages/analyzer";

const analyzable = (files: string[]) => files.filter((f) => analyzerFor(f) !== null).sort();

export function listAnalyzableFiles(repo: string): string[] {
  return analyzable(workingTree(repo).files);
}

// Linear normalization, clamped to [0, 100]. cap = raw value scoring 100.
export function normalize(value: number, cap: number): number {
  if (cap <= 0 || value <= 0) return 0;
  return Math.min(100, (value / cap) * 100);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// Nearest-rank percentile over a copy of `values` (not mutated in place).
function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// One sentence naming the raw fact behind whichever of the three hotspot
// dimensions dominates — so a finding is traceable without cross-referencing
// the scoring config, and an agent doesn't have to guess which signal fired.
function explainHotspot(
  f: FileFacts,
  scores: { complexity_score: number; coupling_score: number; churn_score: number },
): string {
  const dims = [
    { name: "complexity", score: scores.complexity_score, fact: `complexity_max ${f.complexity_max}` },
    { name: "coupling", score: scores.coupling_score, fact: `fan_in ${f.fan_in} + fan_out ${f.fan_out}` },
    { name: "churn", score: scores.churn_score, fact: `${f.commits} commits (${f.weighted_commits} weighted, ${f.churn_trend})` },
  ];
  const top = dims.reduce((a, b) => (b.score > a.score ? b : a));
  const untested = !f.has_test && !f.is_entrypoint && f.complexity_total > 0 ? " — untested" : "";
  if (top.score === 0) return `no dominant signal — all three dimensions are low${untested}`;
  return `driven by ${top.name} (${top.fact})${untested}`;
}

// Everything derived from one file's content alone — what the cache stores.
interface CachedBase {
  language: string;
  loc: number;
  cx: ComplexityResult;
  fp: FileFingerprint;
  imports: string[]; // plugin-encoded specifiers; resolved against the file set every run
  st: {
    types: number; optional: number; boolean: number; max: number;
    clumps: number; maxClump: number; clumpPrefix: string;
    maxOptionalDepth: number; nestedOccurrences: number; nestedPub: boolean;
  };
  mg: { numbers: number; strings: number };
  gd: { groups: number; max: number; prefix: string };
  nest: Nesting;
  comments: number[];
}

// Bump when CachedBase shape or any metric computation changes, so stale
// cache rows recompute instead of deserializing into missing fields.
const CACHE_VERSION = "v16";

export type ProgressFn = (message: string) => void;

// Per-file results of one analysis, reusable by another analysis of a
// mostly-identical tree in the same process (entropy check's base side).
export type BaseMemo = Map<string, { content_hash: string; base: CachedBase }>;

function measure(analyzer: LanguageAnalyzer, src: string): CachedBase {
  const types = analyzer.stateSpace(src);
  const guards = analyzer.sharedConditions(src);
  const worstGuard = guards.reduce((best, g) => (g.count > best.count ? g : best), {
    prefix: "", count: 0, lines: [] as number[],
  });
  return {
    language: analyzer.language,
    loc: countNonBlankLines(src),
    cx: analyzer.complexity(src),
    fp: fingerprint(analyzer.normalizedLines(src).map((l) => l.text)),
    imports: analyzer.imports(src),
    st: {
      types: types.length,
      optional: types.reduce((s, t) => s + t.optional_fields, 0),
      boolean: types.reduce((s, t) => s + t.boolean_fields, 0),
      max: types.reduce((s, t) => Math.max(s, t.optional_fields + t.boolean_fields), 0),
      clumps: types.filter((t) => t.clump_fields > 0).length,
      maxClump: types.reduce((s, t) => Math.max(s, t.clump_fields), 0),
      clumpPrefix: types.reduce(
        (best, t) => (t.clump_fields > best.clump_fields ? t : best),
        { clump_fields: 0, clump_prefix: "" },
      ).clump_prefix,
      maxOptionalDepth: types.reduce((s, t) => Math.max(s, t.max_optional_depth), 0),
      nestedOccurrences: types.reduce((s, t) => s + t.nested_optional_occurrences, 0),
      nestedPub: types.some((t) => t.is_pub && t.max_optional_depth >= 1),
    },
    mg: analyzer.magic(src),
    gd: { groups: guards.length, max: worstGuard.count, prefix: worstGuard.prefix },
    nest: analyzer.nesting(src),
    comments: analyzer.commentLines(src),
  };
}

// Window hashes travel as a raw BLOB beside the JSON, never through it.
function toCacheRow(path: string, content_hash: string, base: CachedBase) {
  const { fp, ...rest } = base;
  return {
    path,
    content_hash,
    base_json: JSON.stringify({ ...rest, fpLines: fp.lineCount }),
    window_hashes: new Uint8Array(fp.hashes.buffer, fp.hashes.byteOffset, fp.hashes.byteLength),
  };
}

function fromCacheRow(row: { base_json: string; window_hashes: Uint8Array }): CachedBase {
  const { fpLines, ...rest } = JSON.parse(row.base_json);
  const bytes = row.window_hashes;
  // Copy: the BLOB's view is not guaranteed to be 8-byte aligned.
  const hashes = new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return { ...rest, fp: { hashes, lineCount: fpLines } };
}

// One log per checkout: worktrees share the cache database but sit on
// different HEADs, and would otherwise evict each other's log every run.
const CHURN_KEY_PREFIX = "churnlog:";

// Churn for the window ending today. The raw log is cached and extended
// incrementally (see git.ts), so only commits new since the last run cost
// a `git log`.
export function loadChurn(
  repo: string,
  since: string,
  storage: Storage | null,
  progress: ProgressFn | null,
): Map<string, FileChurn> {
  const key = CHURN_KEY_PREFIX + worktreeRoot(repo);
  const cached = storage?.kvGet(key);
  const prev: ChurnLog | null = cached ? JSON.parse(cached) : null;
  if (!prev) progress?.("computing churn (git log)…");
  const log = churnLog(repo, since, prev);
  if (storage && log !== prev) {
    storage.kvSet(key, JSON.stringify(log));
    // Logs of checkouts that no longer exist (removed worktrees) go with them.
    for (const other of storage.kvKeys(CHURN_KEY_PREFIX)) {
      if (!existsSync(other.slice(CHURN_KEY_PREFIX.length))) storage.kvDelete(other);
    }
  }
  return summarizeChurn(log, startOfUtcDay());
}

// All parameters are explicit and required — callers resolve defaults
// (CLI flag > config) before calling. storage: null = run stateless;
// progress: null = silent.
export function analyzeRepo(
  repo: string,
  config: EntropyConfig,
  since: string,
  storage: Storage | null,
  progress: ProgressFn | null,
): AnalysisResult {
  progress?.("listing files…");
  const tree = workingTree(repo);
  const churnMap = loadChurn(repo, since, storage, progress);
  return analyzeTree(repo, tree, config, churnMap, { storage, memo: null, progress }).result;
}

// storage: persistent per-file cache (read + written); memo: results of an
// earlier analysis in this process (read only) — either may be null.
export interface AnalysisContext {
  storage: Storage | null;
  memo: BaseMemo | null;
  progress: ProgressFn | null;
}

interface Measured {
  facts: Map<string, FileFacts>;
  files_skipped: string[];
  dupInput: Map<string, FileFingerprint>;
  memo: BaseMemo;
}

function measureFiles(
  tree: SourceTree,
  churnMap: Map<string, FileChurn>,
  ctx: AnalysisContext,
): Measured {
  const { storage, progress } = ctx;
  const paths = analyzable(tree.files);
  const fileSet = new Set(paths);
  const aliases = loadAliases(tree);
  const cacheRows = storage?.loadFileCache() ?? new Map();
  const facts = new Map<string, FileFacts>();
  const files_skipped: string[] = [];
  const dupInput = new Map<string, FileFingerprint>();
  const memo: BaseMemo = new Map();
  const cacheWrites: ReturnType<typeof toCacheRow>[] = [];

  let processed = 0;
  for (const path of paths) {
    if (++processed % 100 === 0 || processed === paths.length) {
      progress?.(`analyzing files ${processed}/${paths.length}…`);
    }
    const src = tree.read(path);
    if (src === null) {
      files_skipped.push(path);
      continue;
    }
    const analyzer = analyzerFor(path)!;
    const contentHash = `${CACHE_VERSION}:${Bun.hash(src)}`;
    const remembered = ctx.memo?.get(path);
    const row = cacheRows.get(path);

    let base: CachedBase;
    if (remembered?.content_hash === contentHash) {
      base = remembered.base;
    } else if (row?.content_hash === contentHash) {
      base = fromCacheRow(row);
    } else {
      base = measure(analyzer, src);
      if (storage) cacheWrites.push(toCacheRow(path, contentHash, base));
    }
    memo.set(path, { content_hash: contentHash, base });
    const deps = analyzer.resolve(base.imports, path, fileSet, aliases);
    const tc = analyzer.testCoverage(src, path, fileSet);

    const cx = base.cx;
    dupInput.set(path, base.fp);
    const ch = churnMap.get(path) ?? {
      commits: 0, lines_added: 0, lines_deleted: 0, weighted_commits: 0,
      trend: "stable" as const,
    };
    facts.set(path, {
      path,
      language: base.language,
      loc: base.loc,
      complexity_total: cx.total,
      complexity_average: round1(cx.average),
      complexity_max: cx.max,
      functions: cx.functions,
      fan_in: 0,
      fan_out: deps.internal.length,
      dependency_count: deps.internal.length + deps.external.length,
      dependent_count: 0,
      dependencies: deps.internal,
      dependents: [],
      commits: ch.commits,
      weighted_commits: ch.weighted_commits,
      churn_trend: ch.trend,
      lines_added: ch.lines_added,
      lines_deleted: ch.lines_deleted,
      lines_changed: ch.lines_added + ch.lines_deleted,
      duplicated_lines: 0,
      duplicated_blocks: 0,
      duplication_percentage: 0,
      duplicate_partners: [],
      type_count: base.st.types,
      optional_fields: base.st.optional,
      boolean_fields: base.st.boolean,
      max_state_fields: base.st.max,
      data_clumps: base.st.clumps,
      max_clump_fields: base.st.maxClump,
      clump_prefix: base.st.clumpPrefix,
      magic_numbers: base.mg.numbers,
      magic_strings: base.mg.strings,
      guard_clumps: base.gd.groups,
      max_guard_group: base.gd.max,
      guard_prefix: base.gd.prefix,
      max_nesting: base.nest.depth,
      nesting_line: base.nest.line,
      has_test: tc.has_test,
      test_path: tc.test_path,
      max_optional_depth: base.st.maxOptionalDepth,
      nested_optional_occurrences: base.st.nestedOccurrences,
      nested_optional_pub: base.st.nestedPub,
      is_entrypoint: isEntrypoint(path),
      is_orphan: false,
      in_cycle: false,
      transitive_dependents: 0,
      arch_violations: 0,
      comment_lines: base.comments,
    });
  }

  if (storage && cacheWrites.length) storage.putFileCaches(cacheWrites);
  return { facts, files_skipped, dupInput, memo };
}

const MAX_REPORTED_VIOLATIONS = 100;

// Imports that point from an inner layer to an outer one (hexagonal direction).
function layerViolations(f: FileFacts, layers: string[]): ArchViolation[] {
  const fromLayer = layerOf(f.path, layers);
  if (fromLayer === -1) return [];
  return f.dependencies.flatMap((dep) => {
    const toLayer = layerOf(dep, layers);
    return toLayer !== -1 && fromLayer < toLayer
      ? [{ from: f.path, to: dep, from_layer: layers[fromLayer], to_layer: layers[toLayer] }]
      : [];
  });
}

// Pass 2: everything that needs the whole dependency graph — fan-in,
// orphans, cycles, reach, transitive test coverage, layer direction.
function linkGraph(facts: Map<string, FileFacts>, config: EntropyConfig): ArchViolation[] {
  for (const from of facts.values()) {
    for (const dep of from.dependencies) {
      const f = facts.get(dep);
      if (f && dep !== from.path) {
        f.fan_in++;
        f.dependent_count++;
        f.dependents.push(from.path);
      }
    }
  }
  for (const f of facts.values()) f.dependents.sort();

  const order = [...facts.keys()]; // node index → path (sorted, so index order is path order)
  const indexOf = new Map(order.map((p, i) => [p, i]));
  const reach = transitiveReach(order.map((p) => facts.get(p)!.dependents.map((d) => indexOf.get(d)!)));
  const testFiles = bitmask(order.length, order.flatMap((p, i) => (isTestFile(p) ? [i] : [])));
  const layers = config.architecture.layers.split(",").map((l) => l.trim()).filter(Boolean);
  const architecture_violations: ArchViolation[] = [];
  for (const f of facts.values()) {
    const node = indexOf.get(f.path)!;
    f.is_orphan = f.fan_in === 0 && !f.is_entrypoint;
    f.in_cycle = reach.cyclic(node);
    f.transitive_dependents = reach.count(node);
    // A companion-file match already covers the common case; this catches
    // files only exercised transitively (e.g. an internal helper imported
    // by another module that a test file imports, not directly by the test).
    if (!f.has_test) {
      const test = reach.firstIn(node, testFiles);
      if (test !== -1) {
        f.has_test = true;
        f.test_path = order[test];
      }
    }
    const outward = layerViolations(f, layers);
    f.arch_violations = outward.length;
    architecture_violations.push(...outward);
  }
  return architecture_violations.slice(0, MAX_REPORTED_VIOLATIONS);
}

// Normalization context shared by every file of one analysis.
interface Scoring {
  config: EntropyConfig;
  totalFiles: number;
  totalLoc: number;
  // The Entropy Index formula, used per file and again for the summary.
  blend: (scoreOf: (signal: Signal) => number) => number;
}

function scoringFor(facts: Map<string, FileFacts>, config: EntropyConfig): Scoring {
  const ew = config.entropy;
  // Normalize by weight sums so custom configs (or older configs missing a
  // newer weight) still yield 0-100 indexes.
  const entropyWeightSum = SIGNALS.reduce((sum, signal) => sum + ew[`${signal}_weight`], 0) || 1;
  return {
    config,
    totalFiles: Math.max(facts.size - 1, 1),
    totalLoc: [...facts.values()].reduce((a, f) => a + f.loc, 0) || 1,
    blend: (scoreOf) =>
      SIGNALS.reduce((sum, signal) => sum + scoreOf(signal) * ew[`${signal}_weight`], 0) /
      entropyWeightSum,
  };
}

// Pass 4: one file's raw facts → its 0-100 scores.
function scoreFile(f: FileFacts, { config, totalFiles, totalLoc, blend }: Scoring): FileMetrics {
  const s = config.scoring;
  const hw = config.hotspots;
  const hotspotWeightSum = hw.complexity_weight + hw.coupling_weight + hw.churn_weight || 1;
  const complexity_score = round1(
    0.5 * normalize(f.complexity_average, s.complexity_avg_cap) +
      0.5 * normalize(f.complexity_max, s.complexity_max_cap),
  );
  const coupling_score = round1(normalize(f.fan_in + f.fan_out, s.coupling_cap));
  const churnPerLine = f.lines_changed / Math.max(f.loc, 1);
  // weighted_commits, not raw commits: a file quiet for a year shouldn't
  // outrank one actively churning this week just because it has more
  // total commits (recency-decayed, 90-day half-life — see git.ts).
  const churn_score = round1(
    0.5 * normalize(f.weighted_commits, s.churn_commits_cap) +
      0.5 * normalize(churnPerLine, s.churn_per_line_cap),
  );
  const duplication_score = round1(f.duplication_percentage);
  // Worst single type drives the score: one struct with `state_fields_cap`
  // optional/bool fields (~2^cap representable states) scores 100.
  const state_score = round1(normalize(f.max_state_fields, s.state_fields_cap));
  // Worst single clump drives the score, like state: one type carrying a
  // `clump_fields_cap`-field flattened entity scores 100.
  const clumping_score = round1(normalize(f.max_clump_fields, s.clump_fields_cap));
  const deadcode_score = f.is_orphan ? 100 : 0;
  const architecture_score = round1(normalize(f.arch_violations, s.arch_violations_cap));
  const reach_score = round1(
    normalize((f.transitive_dependents / totalFiles) * 100, s.reach_percent_cap),
  );
  // Density, not raw count — a big file earns no extra magic budget.
  // Test files are exempt: their literals are assertions, not smells
  // (raw magic_numbers/magic_strings facts are still recorded).
  const magic_score = isTestFile(f.path)
    ? 0
    : round1(
        normalize(((f.magic_numbers + f.magic_strings) / Math.max(f.loc, 1)) * 100, s.magic_per_100loc_cap),
      );
  // Worst single group drives the score, like state/clumping: one guard
  // re-checked `guard_group_cap` times in siblings scores 100.
  const guard_score = round1(normalize(f.max_guard_group, s.guard_group_cap));
  // 0 if tested; if not, scales with how much logic is exposed untested —
  // a trivial file (complexity_total 0, e.g. pure types) naturally scores
  // 0 too, since there's nothing there to protect. Entrypoints/tests are
  // exempt (a CLI dispatcher or the test file itself doesn't need a test).
  const test_score = f.has_test || f.is_entrypoint
    ? 0
    : round1(normalize(f.complexity_total, s.test_complexity_cap));
  // Additive blend, not multiplicative: a post-blend multiplier either
  // vanishes once depth+frequency alone clamp near 100, or over-punishes
  // a single legitimate public PATCH-style field at the low end. See
  // design doc for the worked examples this formula is tuned against.
  const semantic_score = round1(
    Math.min(
      100,
      0.55 * normalize(f.max_optional_depth, s.semantic_depth_cap) +
        0.3 * normalize(f.nested_optional_occurrences, s.semantic_frequency_cap) +
        0.15 * (f.nested_optional_pub ? 100 : 0),
    ),
  );
  // The first FREE_NESTING levels are ordinary code and score 0; from there
  // linearly up to nesting_depth_cap.
  const nesting_score = round1(
    normalize(f.max_nesting - FREE_NESTING, s.nesting_depth_cap - FREE_NESTING),
  );
  const hotspot_score = round1(
    (complexity_score * hw.complexity_weight +
      coupling_score * hw.coupling_weight +
      churn_score * hw.churn_weight) / hotspotWeightSum,
  );
  const why = explainHotspot(f, { complexity_score, coupling_score, churn_score });
  const scores = {
    complexity_score, coupling_score, churn_score, duplication_score, state_score,
    clumping_score, deadcode_score, architecture_score, reach_score, magic_score,
    guard_score, test_score, semantic_score, nesting_score,
  };
  const fileEntropy = blend((signal) => scores[`${signal}_score`]);
  const entropy_score = round1(fileEntropy);
  const reachFraction = f.transitive_dependents / totalFiles;
  return {
    ...f,
    ...scores,
    hotspot_score,
    why,
    entropy_contribution: round1(fileEntropy * (f.loc / totalLoc) * 100) / 100,
    entropy_score,
    priority_score: round1(entropy_score * reachFraction),
  };
}

export function analyzeTree(
  repo: string,
  tree: SourceTree,
  config: EntropyConfig,
  churnMap: Map<string, FileChurn>,
  ctx: AnalysisContext,
): { result: AnalysisResult; memo: BaseMemo } {
  const { facts, files_skipped, dupInput, memo } = measureFiles(tree, churnMap, ctx);

  ctx.progress?.("graph analysis (orphans, reach, architecture)…");
  const architecture_violations = linkGraph(facts, config);

  ctx.progress?.("detecting duplication…");
  for (const [path, dup] of detectDuplication(dupInput)) {
    const f = facts.get(path)!;
    f.duplicated_lines = dup.duplicated_lines;
    f.duplicated_blocks = dup.duplicated_blocks;
    f.duplication_percentage = round1(dup.duplication_percentage);
    f.duplicate_partners = dup.partners;
  }

  const scoring = scoringFor(facts, config);
  const { blend, totalLoc } = scoring;
  const hw = config.hotspots;
  const files: FileMetrics[] = [...facts.values()].map((f) => scoreFile(f, scoring));

  // Summary: LOC-weighted mean per dimension, so per-file entropy
  // contributions sum (up to rounding) to the global entropy index.
  const wmean = (pick: (f: FileMetrics) => number) =>
    round1(files.reduce((a, f) => a + pick(f) * f.loc, 0) / totalLoc);
  const signalMeans = Object.fromEntries(
    SIGNALS.map((signal) => [signal, files.length ? wmean((f) => f[`${signal}_score`]) : 0]),
  ) as Record<Signal, number>;
  const summary: Summary = {
    ...signalMeans,
    entropy: round1(blend((signal) => signalMeans[signal])),
    p95_file_entropy: percentile(files.map((f) => f.entropy_score), 95),
    critical_hotspots: files.filter(
      (f) => f.priority_score >= config.priority.critical_threshold,
    ).length,
  };

  const byLanguage: Record<string, number> = {};
  for (const f of files) byLanguage[f.language] = (byLanguage[f.language] ?? 0) + 1;

  const hotspots = [...files]
    .sort((a, b) => b.hotspot_score - a.hotspot_score || a.path.localeCompare(b.path))
    .slice(0, hw.limit);
  const priority = [...files]
    .sort((a, b) => b.priority_score - a.priority_score || a.path.localeCompare(b.path))
    .slice(0, hw.limit);

  const result: AnalysisResult = {
    version: 14,
    repository: { name: repoName(repo), commit: currentCommit(repo), path: repo },
    timestamp: new Date().toISOString(),
    files_analyzed: files.length,
    files_skipped,
    files_by_language: byLanguage,
    summary,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    hotspots,
    priority,
    cycles: findCycles(new Map([...facts].map(([path, f]) => [path, f.dependencies]))),
    architecture_violations,
    trend: { delta: null, velocity: null },
  };
  return { result, memo };
}

// Files that legitimately have no importers: entrypoints, tests, configs.
const ENTRY_BASENAMES = new Set([
  "main.rs", "lib.rs", "mod.rs", "build.rs",
  "index.ts", "index.tsx", "index.js", "index.mjs",
  "main.ts", "main.tsx", "main.js", "app.ts", "app.tsx", "cli.ts",
]);

export function isEntrypoint(path: string): boolean {
  const base = path.split("/").pop()!;
  if (ENTRY_BASENAMES.has(base)) return true;
  if (isTestFile(path)) return true;
  if (/\.(stories|config|setup)\.[\w.]+$/.test(base)) return true;
  if (/\.(sh|bash|zsh)$/.test(base)) return true; // scripts run, not import
  return /(^|\/)(bin|examples|benches|migrations|scripts)\//.test(path);
}

// First path segment matching a configured layer name decides the layer.
export function layerOf(path: string, layers: string[]): number {
  for (const seg of path.split("/")) {
    const i = layers.indexOf(seg);
    if (i !== -1) return i;
  }
  return -1;
}

// Iterative DFS collecting distinct dependency cycles (capped for sanity).
export function findCycles(graph: Map<string, string[]>, cap = 20): string[][] {
  const cycles: string[][] = [];
  const seenCycle = new Set<string>();
  const visited = new Set<string>();

  for (const start of [...graph.keys()].sort()) {
    if (visited.has(start) || cycles.length >= cap) continue;
    const stack: string[] = [start];
    const onPath = new Map<string, number>([[start, 0]]);
    const iters: string[][] = [[...(graph.get(start) ?? [])]];
    while (stack.length && cycles.length < cap) {
      const nexts = iters[iters.length - 1];
      const next = nexts.shift();
      if (next === undefined) {
        const node = stack.pop()!;
        onPath.delete(node);
        iters.pop();
        visited.add(node);
        continue;
      }
      if (onPath.has(next)) {
        const cycle = stack.slice(onPath.get(next)!);
        const canon = [...cycle].sort().join("→");
        if (!seenCycle.has(canon)) {
          seenCycle.add(canon);
          cycles.push([...cycle, next]);
        }
      } else if (!visited.has(next)) {
        stack.push(next);
        onPath.set(next, stack.length - 1);
        iters.push([...(graph.get(next) ?? [])]);
      }
    }
  }
  return cycles;
}
