import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { AnalysisResult, EntropyConfig, FileFacts, FileMetrics, Summary } from "./types";
import { analyzerFor } from "./languages";
import { countNonBlankLines } from "./languages/strip";
import { churn, currentCommit, headCommit, listTrackedFiles, repoName, sinceToDate } from "./git";
import { detectDuplication, fingerprint, type FileFingerprint } from "./duplication";
import type { Storage } from "./storage";
import type { ComplexityResult, DependencyResult } from "./languages/analyzer";

const SKIP_DIRS = new Set([
  ".git", ".entropy", "node_modules", "target", "target-musl", "dist",
  "build", "out", "vendor", "coverage", ".next", ".cache",
]);

function walkFiles(root: string, dir = root, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name) && !name.startsWith(".")) walkFiles(root, full, acc);
    } else {
      acc.push(relative(root, full).replaceAll("\\", "/"));
    }
  }
  return acc;
}

export function listAnalyzableFiles(repo: string): string[] {
  const files = listTrackedFiles(repo) ?? walkFiles(repo);
  return files
    .filter((f) => !f.split("/").some((seg) => SKIP_DIRS.has(seg)))
    .filter((f) => analyzerFor(f) !== null)
    .sort();
}

// Linear normalization, clamped to [0, 100]. cap = raw value scoring 100.
export function normalize(value: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.min(100, (value / cap) * 100);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

interface CachedBase {
  language: string;
  loc: number;
  cx: ComplexityResult;
  fp: FileFingerprint;
  st: {
    types: number; optional: number; boolean: number; max: number;
    clumps: number; maxClump: number; clumpPrefix: string;
  };
}

// Bump when CachedBase shape or any metric computation changes, so stale
// cache rows recompute instead of deserializing into missing fields.
const CACHE_VERSION = "v3";

export type ProgressFn = (message: string) => void;

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
  const paths = listAnalyzableFiles(repo);
  const fileSet = new Set(paths);
  const filesetHash = String(Bun.hash(paths.join("\n")));

  // Churn depends only on committed history + window → cache per (HEAD, date).
  let churnMap: ReturnType<typeof churn>;
  const churnKey = `churn:${headCommit(repo)}:${sinceToDate(since)}`;
  const cachedChurn = storage?.kvGet(churnKey);
  if (cachedChurn) {
    churnMap = new Map(JSON.parse(cachedChurn));
  } else {
    progress?.(`computing churn since ${sinceToDate(since)} (git log)…`);
    churnMap = churn(repo, since);
    storage?.kvSet(churnKey, JSON.stringify([...churnMap]));
  }

  const sources = new Map<string, string>();
  for (const p of paths) {
    try {
      sources.set(p, readFileSync(join(repo, p), "utf8"));
    } catch {
      /* unreadable (deleted mid-run, permissions) — skip */
    }
  }

  // Pass 1: complexity, deps, duplication fingerprints — cached per file.
  const facts = new Map<string, FileFacts>();
  const depGraph = new Map<string, string[]>(); // path -> internal deps
  const dupInput = new Map<string, FileFingerprint>();
  const cacheWrites: {
    path: string; content_hash: string; fileset_hash: string;
    base_json: string; deps_json: string;
  }[] = [];

  let processed = 0;
  for (const [path, src] of sources) {
    if (++processed % 100 === 0 || processed === sources.size) {
      progress?.(`analyzing files ${processed}/${sources.size}…`);
    }
    const analyzer = analyzerFor(path)!;
    const contentHash = `${CACHE_VERSION}:${Bun.hash(src)}`;
    const row = storage?.getFileCache(path);
    const contentFresh = row?.content_hash === contentHash;

    let base: CachedBase;
    let deps: DependencyResult;
    if (contentFresh) {
      base = JSON.parse(row!.base_json);
    } else {
      const types = analyzer.stateSpace(src);
      base = {
        language: analyzer.language,
        loc: countNonBlankLines(src),
        cx: analyzer.complexity(src),
        fp: fingerprint(analyzer.normalizedLines(src).map((l) => l.text)),
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
        },
      };
    }
    if (contentFresh && row!.fileset_hash === filesetHash) {
      deps = JSON.parse(row!.deps_json);
    } else {
      deps = analyzer.dependencies(src, path, fileSet);
    }
    if (storage && !(contentFresh && row!.fileset_hash === filesetHash)) {
      cacheWrites.push({
        path, content_hash: contentHash, fileset_hash: filesetHash,
        base_json: JSON.stringify(base), deps_json: JSON.stringify(deps),
      });
    }

    const cx = base.cx;
    dupInput.set(path, base.fp);
    depGraph.set(path, deps.internal);
    const ch = churnMap.get(path) ?? { commits: 0, lines_added: 0, lines_deleted: 0 };
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
      lines_added: ch.lines_added,
      lines_deleted: ch.lines_deleted,
      lines_changed: ch.lines_added + ch.lines_deleted,
      duplicated_lines: 0,
      duplicated_blocks: 0,
      duplication_percentage: 0,
      type_count: base.st.types,
      optional_fields: base.st.optional,
      boolean_fields: base.st.boolean,
      max_state_fields: base.st.max,
      data_clumps: base.st.clumps,
      max_clump_fields: base.st.maxClump,
      clump_prefix: base.st.clumpPrefix,
      is_entrypoint: isEntrypoint(path),
      is_orphan: false,
      transitive_dependents: 0,
      arch_violations: 0,
    });
  }

  if (storage && cacheWrites.length) storage.putFileCaches(cacheWrites);

  // Pass 2: fan-in from inverted graph
  for (const [from, deps] of depGraph) {
    for (const dep of deps) {
      const f = facts.get(dep);
      if (f && dep !== from) {
        f.fan_in++;
        f.dependent_count++;
        f.dependents.push(from);
      }
    }
  }
  for (const f of facts.values()) f.dependents.sort();

  progress?.("graph analysis (orphans, reach, architecture)…");
  const reach = transitiveReach(new Map([...facts].map(([p, f]) => [p, f.dependents])));
  const layers = config.architecture.layers.split(",").map((l) => l.trim()).filter(Boolean);
  const architecture_violations: import("./types").ArchViolation[] = [];
  for (const f of facts.values()) {
    f.is_orphan = f.fan_in === 0 && !f.is_entrypoint;
    f.transitive_dependents = reach.get(f.path) ?? 0;
    const fromLayer = layerOf(f.path, layers);
    if (fromLayer === -1) continue;
    for (const dep of f.dependencies) {
      const toLayer = layerOf(dep, layers);
      if (toLayer !== -1 && fromLayer < toLayer) {
        f.arch_violations++;
        if (architecture_violations.length < 100) {
          architecture_violations.push({
            from: f.path, to: dep,
            from_layer: layers[fromLayer], to_layer: layers[toLayer],
          });
        }
      }
    }
  }

  progress?.("detecting duplication…");
  // Pass 3: duplication across the whole repo
  for (const [path, dup] of detectDuplication(dupInput)) {
    const f = facts.get(path)!;
    f.duplicated_lines = dup.duplicated_lines;
    f.duplicated_blocks = dup.duplicated_blocks;
    f.duplication_percentage = round1(dup.duplication_percentage);
  }

  // Pass 4: scores
  const s = config.scoring;
  const hw = config.hotspots;
  const ew = config.entropy;
  // Normalize by weight sums so custom configs (or older configs missing a
  // newer weight) still yield 0-100 indexes.
  const entropyWeightSum =
    ew.complexity_weight + ew.coupling_weight + ew.churn_weight +
      ew.duplication_weight + ew.state_weight + ew.clumping_weight +
      ew.deadcode_weight + ew.architecture_weight + ew.reach_weight || 1;
  const totalFiles = Math.max(facts.size - 1, 1);
  const hotspotWeightSum =
    hw.complexity_weight + hw.coupling_weight + hw.churn_weight || 1;
  const totalLoc = [...facts.values()].reduce((a, f) => a + f.loc, 0) || 1;

  const files: FileMetrics[] = [...facts.values()].map((f) => {
    const complexity_score = round1(
      0.5 * normalize(f.complexity_average, s.complexity_avg_cap) +
        0.5 * normalize(f.complexity_max, s.complexity_max_cap),
    );
    const coupling_score = round1(normalize(f.fan_in + f.fan_out, s.coupling_cap));
    const churnPerLine = f.lines_changed / Math.max(f.loc, 1);
    const churn_score = round1(
      0.5 * normalize(f.commits, s.churn_commits_cap) +
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
    const hotspot_score = round1(
      (complexity_score * hw.complexity_weight +
        coupling_score * hw.coupling_weight +
        churn_score * hw.churn_weight) / hotspotWeightSum,
    );
    const fileEntropy =
      (complexity_score * ew.complexity_weight +
        coupling_score * ew.coupling_weight +
        churn_score * ew.churn_weight +
        duplication_score * ew.duplication_weight +
        state_score * ew.state_weight +
        clumping_score * ew.clumping_weight +
        deadcode_score * ew.deadcode_weight +
        architecture_score * ew.architecture_weight +
        reach_score * ew.reach_weight) / entropyWeightSum;
    return {
      ...f,
      complexity_score,
      coupling_score,
      churn_score,
      duplication_score,
      state_score,
      clumping_score,
      deadcode_score,
      architecture_score,
      reach_score,
      hotspot_score,
      entropy_contribution: round1(fileEntropy * (f.loc / totalLoc) * 100) / 100,
    };
  });

  // Summary: LOC-weighted mean per dimension, so per-file entropy
  // contributions sum (up to rounding) to the global entropy index.
  const wmean = (pick: (f: FileMetrics) => number) =>
    round1(files.reduce((a, f) => a + pick(f) * f.loc, 0) / totalLoc);
  const summary: Summary = files.length
    ? {
        complexity: wmean((f) => f.complexity_score),
        coupling: wmean((f) => f.coupling_score),
        churn: wmean((f) => f.churn_score),
        duplication: wmean((f) => f.duplication_score),
        state: wmean((f) => f.state_score),
        clumping: wmean((f) => f.clumping_score),
        deadcode: wmean((f) => f.deadcode_score),
        architecture: wmean((f) => f.architecture_score),
        reach: wmean((f) => f.reach_score),
        entropy: 0,
      }
    : {
        complexity: 0, coupling: 0, churn: 0, duplication: 0, state: 0,
        clumping: 0, deadcode: 0, architecture: 0, reach: 0, entropy: 0,
      };
  summary.entropy = round1(
    (summary.complexity * ew.complexity_weight +
      summary.coupling * ew.coupling_weight +
      summary.churn * ew.churn_weight +
      summary.duplication * ew.duplication_weight +
      summary.state * ew.state_weight +
      summary.clumping * ew.clumping_weight +
      summary.deadcode * ew.deadcode_weight +
      summary.architecture * ew.architecture_weight +
      summary.reach * ew.reach_weight) / entropyWeightSum,
  );

  const byLanguage: Record<string, number> = {};
  for (const f of files) byLanguage[f.language] = (byLanguage[f.language] ?? 0) + 1;

  const hotspots = [...files]
    .sort((a, b) => b.hotspot_score - a.hotspot_score || a.path.localeCompare(b.path))
    .slice(0, hw.limit);

  return {
    version: 4,
    repository: { name: repoName(repo), commit: currentCommit(repo), path: repo },
    timestamp: new Date().toISOString(),
    files_analyzed: files.length,
    files_by_language: byLanguage,
    summary,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    hotspots,
    cycles: findCycles(depGraph),
    architecture_violations,
    trend: { delta: null, velocity: null },
  };
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
  if (/\.(test|spec|stories|config|setup)\.[\w.]+$/.test(base)) return true;
  // Rust test modules are pulled in via `#[cfg(test)] mod x;` — attribute
  // and declaration share a line, which the mod-import regex doesn't track.
  if (/(_tests?|^tests?)\.rs$/.test(base)) return true;
  if (/\.(sh|bash|zsh)$/.test(base)) return true; // scripts run, not import
  return /(^|\/)(bin|tests|__tests__|examples|benches|migrations|scripts)\//.test(path);
}

// Transitive dependents per file: BFS over the inverted dependency graph.
export function transitiveReach(dependents: Map<string, string[]>): Map<string, number> {
  const reach = new Map<string, number>();
  for (const start of dependents.keys()) {
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length) {
      for (const dep of dependents.get(queue.pop()!) ?? []) {
        if (!seen.has(dep)) {
          seen.add(dep);
          queue.push(dep);
        }
      }
    }
    reach.set(start, seen.size - 1);
  }
  return reach;
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
