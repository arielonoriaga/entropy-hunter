import type { AnalysisResult, FileMetrics } from "./types";
import { withDeltas, type SnapshotRow } from "./storage";

const fmt = (n: number) => n.toFixed(1);

export function trendLabel(delta: number | null): string {
  if (delta === null) return "UNKNOWN";
  if (delta > 0.5) return `RISING (+${fmt(delta)})`;
  if (delta < -0.5) return `FALLING (${fmt(delta)})`;
  return `STABLE (${delta >= 0 ? "+" : ""}${fmt(delta)})`;
}

export function renderAnalysis(r: AnalysisResult): string {
  const langs = Object.entries(r.files_by_language)
    .map(([l, n]) => `${l[0].toUpperCase() + l.slice(1)} files: ${n}`)
    .join("\n");
  return `Entropy Analysis

Repository: ${r.repository.name}
Commit: ${r.repository.commit}

Files analyzed: ${r.files_analyzed}${r.files_skipped.length ? ` (${r.files_skipped.length} skipped — unreadable)` : ""}
${langs}

Complexity:   ${fmt(r.summary.complexity)}
Coupling:     ${fmt(r.summary.coupling)}
Churn:        ${fmt(r.summary.churn)}
Duplication:  ${fmt(r.summary.duplication)}
State:        ${fmt(r.summary.state)}
Clumping:     ${fmt(r.summary.clumping)}
Dead code:    ${fmt(r.summary.deadcode)}
Architecture: ${fmt(r.summary.architecture)}
Reach:        ${fmt(r.summary.reach)}
Magic:        ${fmt(r.summary.magic)}
Guard:        ${fmt(r.summary.guard)}

Entropy Index: ${fmt(r.summary.entropy)}

Trend: ${trendLabel(r.trend.delta)}${
    r.cycles.length ? `\n\nCircular dependencies: ${r.cycles.length} (see report --format json)` : ""
  }${
    r.architecture_violations.length
      ? `\nArchitecture violations: ${r.architecture_violations.length} (see report --format json)`
      : ""
  }`;
}

export function renderHotspots(hotspots: FileMetrics[], limit: number): string {
  const rows = hotspots.slice(0, limit).map(
    (h, i) =>
      `${i + 1}. ${h.path}
   score: ${Math.round(h.hotspot_score)} — ${h.why}
   complexity: ${Math.round(h.complexity_score)}
   coupling: ${Math.round(h.coupling_score)}
   churn: ${Math.round(h.churn_score)}`,
  );
  return `HOTSPOTS\n\n${rows.join("\n\n") || "(no files analyzed — measured, and clean)"}`;
}

export function renderFile(f: FileMetrics): string {
  const topFns = [...f.functions]
    .sort((a, b) => b.complexity - a.complexity)
    .slice(0, 5)
    .map((fn) => `    ${fn.name} (line ${fn.line}): ${fn.complexity}`)
    .join("\n");
  return `${f.path}

Entropy contribution: ${f.entropy_contribution}

Complexity
  total: ${f.complexity_total}
  average: ${f.complexity_average}
  max: ${f.complexity_max}
${topFns ? `  top functions:\n${topFns}\n` : ""}
Coupling
  fan-in: ${f.fan_in}
  fan-out: ${f.fan_out}
  dependencies: ${f.dependency_count}
  dependents: ${f.dependent_count}

Churn
  commits: ${f.commits} (${f.weighted_commits} recency-weighted, ${f.churn_trend})
  additions: ${f.lines_added}
  deletions: ${f.lines_deleted}

Duplication
  ${fmt(f.duplication_percentage)}%

State space
  types: ${f.type_count}
  optional fields: ${f.optional_fields}
  boolean fields: ${f.boolean_fields}
  worst type: ${f.max_state_fields} state fields (~2^${f.max_state_fields} representable states)

Data clumps
  groups of 3+ same-prefix fields: ${f.data_clumps}${
    f.max_clump_fields
      ? `\n  worst: ${f.max_clump_fields} "${f.clump_prefix}_*" fields — consider extracting a ${f.clump_prefix} entity`
      : ""
  }

Magic literals
  numbers: ${f.magic_numbers}
  strings (comparisons/arms): ${f.magic_strings}

Guard clumps
  groups of 2+ sibling ifs sharing a guard: ${f.guard_clumps}${
    f.max_guard_group
      ? `\n  worst: ${f.max_guard_group} ifs guarded by "${f.guard_prefix}" — consolidate into one guard with nested/early-return branches`
      : ""
  }

Graph
  transitive dependents: ${f.transitive_dependents}${f.is_orphan ? "\n  ORPHAN: nothing imports this file (possible dead code)" : ""}${
    f.arch_violations ? `\n  architecture violations: ${f.arch_violations} inner→outer imports` : ""
  }

Hotspot score: ${Math.round(f.hotspot_score)}`;
}

export function renderHistory(rows: SnapshotRow[]): string {
  if (!rows.length) return "No snapshots yet. Run: entropy snapshot";
  const withD = withDeltas(rows);
  const lines = withD.map((r) => {
    const date = r.timestamp.slice(0, 10);
    const delta = r.delta === null ? "-" : `${r.delta >= 0 ? "+" : ""}${fmt(r.delta)}`;
    return `${date}  ${r.commit_hash.padEnd(10)} ${fmt(r.entropy).padStart(7)} ${delta.padStart(8)}`;
  });
  return `DATE        COMMIT     ENTROPY    DELTA\n${lines.join("\n")}`;
}

export function renderMarkdown(r: AnalysisResult): string {
  const hs = r.hotspots
    .map(
      (h, i) =>
        `| ${i + 1} | \`${h.path}\` | ${Math.round(h.hotspot_score)} | ${Math.round(h.complexity_score)} | ${Math.round(h.coupling_score)} | ${Math.round(h.churn_score)} | ${h.why} |`,
    )
    .join("\n");
  return `# Entropy Report — ${r.repository.name}

Commit \`${r.repository.commit}\` · ${r.timestamp.slice(0, 10)} · ${r.files_analyzed} files

> Scores are deterministic engineering heuristics normalized to 0–100.
> They are traceable to raw metrics, not universal measurements.

## Summary

| Metric | Score |
|---|---|
| **Entropy Index** | **${fmt(r.summary.entropy)}** |
| Complexity | ${fmt(r.summary.complexity)} |
| Coupling | ${fmt(r.summary.coupling)} |
| Churn | ${fmt(r.summary.churn)} |
| Duplication | ${fmt(r.summary.duplication)} |
| State | ${fmt(r.summary.state)} |
| Clumping | ${fmt(r.summary.clumping)} |
| Dead code | ${fmt(r.summary.deadcode)} |
| Architecture | ${fmt(r.summary.architecture)} |
| Reach | ${fmt(r.summary.reach)} |
| Magic | ${fmt(r.summary.magic)} |
| Guard | ${fmt(r.summary.guard)} |

Trend: ${trendLabel(r.trend.delta)}

## Hotspots

| # | File | Score | Complexity | Coupling | Churn | Why |
|---|---|---|---|---|---|---|
${hs || "| - | *(none — measured, and clean)* | | | | | |"}
${r.cycles.length ? `\n## Circular dependencies\n\n${r.cycles.map((c) => `- ${c.join(" → ")}`).join("\n")}` : ""}${
    r.architecture_violations.length
      ? `\n## Architecture violations\n\n${r.architecture_violations.map((v) => `- \`${v.from}\` (${v.from_layer}) → \`${v.to}\` (${v.to_layer})`).join("\n")}`
      : ""
  }${r.files_skipped.length ? `\n## Files skipped\n\n${r.files_skipped.map((p) => `- \`${p}\``).join("\n")}` : ""}`;
}
