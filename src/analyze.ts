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
}

// All parameters are explicit and required — callers resolve defaults
// (CLI flag > config) before calling. storage: null = run stateless.
export function analyzeRepo(
  repo: string,
  config: EntropyConfig,
  since: string,
  storage: Storage | null,
): AnalysisResult {
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

  for (const [path, src] of sources) {
    const analyzer = analyzerFor(path)!;
    const contentHash = String(Bun.hash(src));
    const row = storage?.getFileCache(path);
    const contentFresh = row?.content_hash === contentHash;

    let base: CachedBase;
    let deps: DependencyResult;
    if (contentFresh) {
      base = JSON.parse(row!.base_json);
    } else {
      base = {
        language: analyzer.language,
        loc: countNonBlankLines(src),
        cx: analyzer.complexity(src),
        fp: fingerprint(analyzer.normalizedLines(src).map((l) => l.text)),
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
      commits: ch.commits,
      lines_added: ch.lines_added,
      lines_deleted: ch.lines_deleted,
      lines_changed: ch.lines_added + ch.lines_deleted,
      duplicated_lines: 0,
      duplicated_blocks: 0,
      duplication_percentage: 0,
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
      }
    }
  }

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
    const hotspot_score = round1(
      complexity_score * hw.complexity_weight +
        coupling_score * hw.coupling_weight +
        churn_score * hw.churn_weight,
    );
    const fileEntropy =
      complexity_score * ew.complexity_weight +
      coupling_score * ew.coupling_weight +
      churn_score * ew.churn_weight +
      duplication_score * ew.duplication_weight;
    return {
      ...f,
      complexity_score,
      coupling_score,
      churn_score,
      duplication_score,
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
        entropy: 0,
      }
    : { complexity: 0, coupling: 0, churn: 0, duplication: 0, entropy: 0 };
  summary.entropy = round1(
    summary.complexity * ew.complexity_weight +
      summary.coupling * ew.coupling_weight +
      summary.churn * ew.churn_weight +
      summary.duplication * ew.duplication_weight,
  );

  const byLanguage: Record<string, number> = {};
  for (const f of files) byLanguage[f.language] = (byLanguage[f.language] ?? 0) + 1;

  const hotspots = [...files]
    .sort((a, b) => b.hotspot_score - a.hotspot_score || a.path.localeCompare(b.path))
    .slice(0, hw.limit);

  return {
    version: 1,
    repository: { name: repoName(repo), commit: currentCommit(repo), path: repo },
    timestamp: new Date().toISOString(),
    files_analyzed: files.length,
    files_by_language: byLanguage,
    summary,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    hotspots,
    cycles: findCycles(depGraph),
    trend: { delta: null, velocity: null },
  };
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
