// The one deliberate exception to "interpretation is out of scope" (see
// README's 3-layer data model): a small, fixed, auditable rule table over
// already-computed scores — not free-form judgment. Every rule here is
// documented in the README alongside its trigger condition.
import { SIGNALS, type AnalysisResult, type Signal } from "./types";

export type Band = "HEALTHY" | "ATTENTION" | "CRITICAL";
export type Color = "green" | "yellow" | "red" | "gray";

export interface HealthLine {
  label: string;
  value: string;
  status: string;
  color: Color;
}

export interface SignalLine {
  label: string;
  score: number;
  color: Color;
}

export interface StructuralLine {
  label: string;
  count: number;
  band: "HEALTHY" | "ATTENTION";
  color: Color;
}

export interface HealthReport {
  entropy: HealthLine;
  p95: HealthLine;
  critical: HealthLine;
  trend: HealthLine;
  attention: SignalLine[];
  structural: StructuralLine[];
  recommendations: string[];
}

export const SIGNAL_LABELS: Record<Signal, string> = {
  complexity: "Complexity", coupling: "Coupling", churn: "Churn", duplication: "Duplication",
  state: "State", clumping: "Clumping", deadcode: "Dead code", architecture: "Architecture",
  reach: "Reach", magic: "Magic", guard: "Guard", test: "Test", semantic: "Semantic",
  nesting: "Nesting",
};

// Same 30/70 split used for per-file severity elsewhere, collapsed to the
// three summary-level bands (no orange tier — HEALTHY/ATTENTION/CRITICAL).
function scoreBand(score: number): { band: Band; color: Color } {
  if (score >= 70) return { band: "CRITICAL", color: "red" };
  if (score >= 30) return { band: "ATTENTION", color: "yellow" };
  return { band: "HEALTHY", color: "green" };
}

function trendWord(delta: number | null): { word: string; color: Color } {
  if (delta === null) return { word: "UNKNOWN", color: "gray" };
  if (delta > 0.5) return { word: "RISING", color: "red" };
  if (delta < -0.5) return { word: "FALLING", color: "green" };
  return { word: "STABLE", color: "green" };
}

export function computeHealth(r: AnalysisResult): HealthReport {
  const { summary, trend, cycles, architecture_violations } = r;

  const entropyBand = scoreBand(summary.entropy);
  const p95Band = scoreBand(summary.p95_file_entropy);

  const critical = summary.critical_hotspots;
  const criticalStatus =
    critical === 0 ? { status: "NONE", color: "green" as Color, band: "HEALTHY" as Band }
    : critical < 5 ? { status: "SOME", color: "yellow" as Color, band: "ATTENTION" as Band }
    : { status: "HIGH", color: "red" as Color, band: "CRITICAL" as Band };

  const trendInfo = trendWord(trend.delta);
  const trendValue = trend.delta === null ? "-" : `${trend.delta >= 0 ? "+" : ""}${trend.delta.toFixed(1)}`;

  const attention: SignalLine[] = SIGNALS
    .map((k) => ({ key: k, score: summary[k] }))
    .filter((s) => s.score >= 30)
    .sort((a, b) => b.score - a.score)
    .map((s) => ({ label: SIGNAL_LABELS[s.key], score: s.score, color: scoreBand(s.score).color }));

  const structural: StructuralLine[] = [
    { label: "Cycles", count: cycles.length, ...structuralBand(cycles.length) },
    { label: "Arch violations", count: architecture_violations.length, ...structuralBand(architecture_violations.length) },
  ];

  const recommendations: string[] = [];
  if (summary.churn >= 30) recommendations.push("High-churn modules");
  if (summary.reach >= 30 && summary.churn >= 30) recommendations.push("High-reach, high-churn modules");
  if (cycles.length > 0) recommendations.push("Circular dependencies");
  if (summary.state >= 30) recommendations.push("State-heavy domain types");

  return {
    entropy: { label: "Entropy", value: summary.entropy.toFixed(1), status: entropyBand.band, color: entropyBand.color },
    p95: { label: "P95", value: summary.p95_file_entropy.toFixed(1), status: p95Band.band, color: p95Band.color },
    critical: { label: "Critical", value: String(critical), status: criticalStatus.status, color: criticalStatus.color },
    trend: { label: "Trend", value: trendValue, status: trendInfo.word, color: trendInfo.color },
    attention,
    structural,
    recommendations,
  };
}

function structuralBand(count: number): { band: "HEALTHY" | "ATTENTION"; color: Color } {
  return count > 0 ? { band: "ATTENTION", color: "yellow" } : { band: "HEALTHY", color: "green" };
}
