import pc from "picocolors";
import type { AnalysisResult, FileMetrics } from "./types";
import type { Color, HealthReport } from "./health";
import { withDeltas, type SnapshotRow } from "./storage";

const fmt = (n: number) => n.toFixed(1);

// Same 0-100 severity bands as the priority dots — picks the color a score
// (entropy/hotspot/priority) renders in on a TTY. No-ops (plain text) when
// piped or NO_COLOR is set — picocolors detects both automatically.
function severity(score: number): (s: string) => string {
  if (score >= 70) return pc.red;
  if (score >= 50) return pc.yellow;
  if (score >= 30) return (s: string) => pc.yellow(pc.dim(s));
  return pc.green;
}

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
  const trend = trendLabel(r.trend.delta);
  const trendColor = trend.startsWith("RISING") ? pc.red : trend.startsWith("FALLING") ? pc.green : pc.dim;
  return `${pc.bold("Entropy Analysis")}

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
Test:         ${fmt(r.summary.test)}

Entropy Index: ${severity(r.summary.entropy)(fmt(r.summary.entropy))}
P95 File Entropy: ${severity(r.summary.p95_file_entropy)(fmt(r.summary.p95_file_entropy))}
Critical Hotspots: ${r.summary.critical_hotspots > 0 ? pc.red(String(r.summary.critical_hotspots)) : pc.green("0")}

Trend: ${trendColor(trend)}${
    r.cycles.length ? `\n\nCircular dependencies: ${r.cycles.length} (see report --format json)` : ""
  }${
    r.architecture_violations.length
      ? `\nArchitecture violations: ${r.architecture_violations.length} (see report --format json)`
      : ""
  }`;
}

export function renderHotspots(hotspots: FileMetrics[], limit: number): string {
  const rows = hotspots.slice(0, limit).map((h, i) => {
    const score = Math.round(h.hotspot_score);
    return `${i + 1}. ${h.path}
   score: ${severity(score)(String(score))} — ${h.why}
   complexity: ${Math.round(h.complexity_score)}
   coupling: ${Math.round(h.coupling_score)}
   churn: ${Math.round(h.churn_score)}`;
  });
  return `${pc.bold("HOTSPOTS")}\n\n${rows.join("\n\n") || "(no files analyzed — measured, and clean)"}`;
}

const SEVERITY_BUCKETS = [
  { min: 70, dot: "🔴" },
  { min: 50, dot: "🟠" },
  { min: 30, dot: "🟡" },
  { min: 0, dot: "🟢" },
] as const;

function scoreDot(score: number): string {
  return SEVERITY_BUCKETS.find((b) => score >= b.min)!.dot;
}

export function renderPriority(files: FileMetrics[], limit: number): string {
  const title = "REFACTOR PRIORITY";
  const sorted = [...files]
    .sort((a, b) => b.priority_score - a.priority_score || a.path.localeCompare(b.path))
    .slice(0, limit);
  if (!sorted.length) return `${title}\n\n(no files analyzed — measured, and clean)`;
  const scoreText = (f: FileMetrics) => Math.round(f.priority_score).toString().padStart(3);
  const rows = sorted.map((f) => `${f.path}  ${scoreDot(f.priority_score)} ${scoreText(f)}`);
  const width = Math.max(title.length, ...rows.map((row) => row.length));
  const line = (l: string, r: string) => `${l}${"─".repeat(width + 2)}${r}`;
  // Pad on the plain (uncolored) string so box alignment isn't thrown off by
  // invisible ANSI escape sequences, then wrap just the score in color.
  const pad = (s: string) => `│ ${s.padEnd(width)} │`;
  const coloredRows = sorted.map((f, i) =>
    pad(rows[i]).replace(scoreText(f), severity(f.priority_score)(scoreText(f))),
  );
  return [line("┌", "┐"), pad(title), line("├", "┤"), ...coloredRows, line("└", "┘")].join("\n");
}

const COLOR_DOT: Record<Color, string> = { green: "🟢", yellow: "🟡", red: "🔴", gray: "⚪" };
const COLOR_FN: Record<Color, (s: string) => string> = {
  green: pc.green, yellow: pc.yellow, red: pc.red, gray: pc.dim,
};

export function renderHealth(h: HealthReport): string {
  const lines = [h.entropy, h.p95, h.critical, h.trend];
  // Widths span every section (topline + attention + structural), not just
  // the topline — otherwise a longer label like "Arch violations" breaks
  // column alignment further down the block.
  const labelWidth = Math.max(
    ...lines.map((l) => l.label.length),
    ...h.attention.map((a) => a.label.length),
    ...h.structural.map((s) => s.label.length),
  );
  const valueWidth = Math.max(
    ...lines.map((l) => l.value.length),
    ...h.attention.map((a) => fmt(a.score).length),
    ...h.structural.map((s) => String(s.count).length),
  );
  const topline = lines
    .map(
      (l) =>
        `${l.label.padEnd(labelWidth)}  ${l.value.padStart(valueWidth)}  ${COLOR_DOT[l.color]}  ${COLOR_FN[l.color](l.status)}`,
    )
    .join("\n");

  const attention = h.attention.length
    ? `\n\nAttention:\n${h.attention
        .map((a) => `  ${a.label.padEnd(labelWidth)}  ${fmt(a.score).padStart(valueWidth)}  ${COLOR_DOT[a.color]}`)
        .join("\n")}`
    : "";

  const structural = h.structural.length
    ? `\n\nStructural:\n${h.structural
        .map((s) => `  ${s.label.padEnd(labelWidth)}  ${String(s.count).padStart(valueWidth)}  ${COLOR_DOT[s.color]}`)
        .join("\n")}`
    : "";

  const recommendation = h.recommendations.length
    ? `\n\nRecommendation:\n  Investigate:\n${h.recommendations.map((r, i) => `    ${i + 1}. ${r}`).join("\n")}`
    : `\n\nRecommendation:\n  No broad refactoring recommended.`;

  return `${pc.bold("REPOSITORY HEALTH")}\n\n${topline}${attention}${structural}${recommendation}`;
}

export function renderFile(f: FileMetrics): string {
  const topFns = [...f.functions]
    .sort((a, b) => b.complexity - a.complexity)
    .slice(0, 5)
    .map((fn) => `    ${fn.name} (line ${fn.line}): ${fn.complexity}`)
    .join("\n");
  return `${pc.bold(f.path)}

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

Test coverage
  ${f.has_test ? `covered (${f.test_path})` : "NO TEST FOUND"}

Graph
  transitive dependents: ${f.transitive_dependents}${f.is_orphan ? "\n  ORPHAN: nothing imports this file (possible dead code)" : ""}${
    f.arch_violations ? `\n  architecture violations: ${f.arch_violations} inner→outer imports` : ""
  }

Hotspot score: ${severity(f.hotspot_score)(String(Math.round(f.hotspot_score)))}`;
}

export function renderHistory(rows: SnapshotRow[]): string {
  if (!rows.length) return "No snapshots yet. Run: entropy snapshot";
  const withD = withDeltas(rows);
  const lines = withD.map((r) => {
    const date = r.timestamp.slice(0, 10);
    const delta = r.delta === null ? "-" : `${r.delta >= 0 ? "+" : ""}${fmt(r.delta)}`;
    const deltaColor = r.delta === null ? pc.dim : r.delta > 0 ? pc.red : r.delta < 0 ? pc.green : pc.dim;
    return `${date}  ${r.commit_hash.padEnd(10)} ${fmt(r.entropy).padStart(7)} ${deltaColor(delta.padStart(8))}`;
  });
  return `${pc.bold("DATE        COMMIT     ENTROPY    DELTA")}\n${lines.join("\n")}`;
}

export function renderHealthMarkdown(health: HealthReport): string {
  const attentionMd = health.attention
    .map((a) => `| ${a.label} | ${fmt(a.score)} | ${COLOR_DOT[a.color]} |`)
    .join("\n");
  const structuralMd = health.structural
    .map((s) => `| ${s.label} | ${s.count} | ${COLOR_DOT[s.color]} |`)
    .join("\n");
  const recommendationMd = health.recommendations.length
    ? health.recommendations.map((rec, i) => `${i + 1}. ${rec}`).join("\n")
    : "No broad refactoring recommended.";
  return `## Repository Health

| Metric | Value | Status |
|---|---|---|
| Entropy | ${health.entropy.value} | ${COLOR_DOT[health.entropy.color]} ${health.entropy.status} |
| P95 | ${health.p95.value} | ${COLOR_DOT[health.p95.color]} ${health.p95.status} |
| Critical | ${health.critical.value} | ${COLOR_DOT[health.critical.color]} ${health.critical.status} |
| Trend | ${health.trend.value} | ${COLOR_DOT[health.trend.color]} ${health.trend.status} |
${attentionMd ? `\n**Attention**\n\n| Signal | Score | |\n|---|---|---|\n${attentionMd}\n` : ""}
${structuralMd ? `\n**Structural**\n\n| Signal | Count | |\n|---|---|---|\n${structuralMd}\n` : ""}
**Recommendation**

${recommendationMd}`;
}

export function renderMarkdown(r: AnalysisResult, health: HealthReport): string {
  const hs = r.hotspots
    .map(
      (h, i) =>
        `| ${i + 1} | \`${h.path}\` | ${Math.round(h.hotspot_score)} | ${Math.round(h.complexity_score)} | ${Math.round(h.coupling_score)} | ${Math.round(h.churn_score)} | ${h.why} |`,
    )
    .join("\n");
  const pr = r.priority
    .map(
      (p, i) =>
        `| ${i + 1} | \`${p.path}\` | ${scoreDot(p.priority_score)} ${Math.round(p.priority_score)} | ${Math.round(p.entropy_score)} | ${fmt((p.transitive_dependents / Math.max(r.files_analyzed - 1, 1)) * 100)}% |`,
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
| P95 File Entropy | ${fmt(r.summary.p95_file_entropy)} |
| Critical Hotspots | ${r.summary.critical_hotspots} |
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
| Test | ${fmt(r.summary.test)} |

Trend: ${trendLabel(r.trend.delta)}

${renderHealthMarkdown(health)}

## Hotspots

| # | File | Score | Complexity | Coupling | Churn | Why |
|---|---|---|---|---|---|---|
${hs || "| - | *(none — measured, and clean)* | | | | | |"}

## Refactor Priority

Entropy × reach — how bad a file is, weighted by how much of the codebase breaks when it changes.

| # | File | Priority | Entropy | Reach |
|---|---|---|---|---|
${pr || "| - | *(none — measured, and clean)* | | | |"}
${r.cycles.length ? `\n## Circular dependencies\n\n${r.cycles.map((c) => `- ${c.join(" → ")}`).join("\n")}` : ""}${
    r.architecture_violations.length
      ? `\n## Architecture violations\n\n${r.architecture_violations.map((v) => `- \`${v.from}\` (${v.from_layer}) → \`${v.to}\` (${v.to_layer})`).join("\n")}`
      : ""
  }${r.files_skipped.length ? `\n## Files skipped\n\n${r.files_skipped.map((p) => `- \`${p}\``).join("\n")}` : ""}`;
}
