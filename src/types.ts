// Layered data model: raw facts (deterministic measurements) vs derived
// scores (deterministic normalization). Interpretation is deliberately out
// of scope — that layer belongs to a future agent consuming the JSON.

export interface FunctionComplexity {
  name: string;
  complexity: number;
  line: number;
}

export interface FileFacts {
  path: string; // repo-relative, forward slashes
  language: string;
  loc: number; // non-blank lines
  complexity_total: number;
  complexity_average: number;
  complexity_max: number;
  functions: FunctionComplexity[];
  fan_in: number; // internal files importing this file
  fan_out: number; // internal files this file imports
  dependency_count: number; // fan_out + external imports
  dependent_count: number; // == fan_in
  dependencies: string[]; // resolved internal deps (for agents: get_dependencies)
  dependents: string[]; // internal files importing this one (get_dependents)
  commits: number;
  weighted_commits: number; // recency-decayed (90-day half-life) — recent churn outweighs old
  churn_trend: "accelerating" | "stable" | "cooling";
  lines_added: number;
  lines_deleted: number;
  lines_changed: number;
  duplicated_lines: number;
  duplicated_blocks: number;
  duplication_percentage: number;
  // State-space exposure: optional/boolean fields multiply representable
  // states (~2^n); illegal-but-representable states breed defensive code.
  type_count: number; // declared types scanned (structs / interfaces / type literals)
  optional_fields: number; // Option<T> / `x?:` / `| null | undefined` fields, all types
  boolean_fields: number; // bool / boolean fields, all types
  max_state_fields: number; // worst single type: optional + boolean fields
  // Data clumps: fields sharing a name prefix (order_id, order_date, …) are
  // a flattened entity wanting extraction into `order: Order`.
  data_clumps: number; // prefix groups of 3+ fields across all types
  max_clump_fields: number; // worst single group size
  clump_prefix: string; // that group's prefix ("" if none)
  // Guard clumps: sibling ifs sharing a leading condition ("Consolidate
  // Conditional Expression") — the guard is re-checked N times instead of
  // once with nested/early-return branches inside.
  guard_clumps: number; // groups of 2+ sibling ifs sharing a leading conjunct
  max_guard_group: number; // worst single group's ifs count
  guard_prefix: string; // that group's shared leading condition ("" if none)
  // Graph-derived (recomputed each run, not content-cached):
  // Magic literals: unnamed numbers in logic, strings in comparisons/arms.
  magic_numbers: number;
  magic_strings: number;
  is_entrypoint: boolean; // main/lib/index/bin/tests — legitimately importless
  is_orphan: boolean; // fan_in == 0 and not an entrypoint: likely dead
  transitive_dependents: number; // files that can break when this one changes
  arch_violations: number; // imports that point inner→outer against [architecture] layers
}

export interface FileScores {
  complexity_score: number;
  coupling_score: number;
  churn_score: number;
  duplication_score: number;
  state_score: number;
  clumping_score: number;
  deadcode_score: number;
  architecture_score: number;
  reach_score: number;
  magic_score: number;
  guard_score: number;
  // One sentence naming the dominant raw fact behind hotspot_score, so an
  // agent (or human) doesn't have to reverse-engineer which signal fired.
  why: string;
  hotspot_score: number;
  entropy_contribution: number;
}

export type FileMetrics = FileFacts & FileScores;

export interface Summary {
  entropy: number;
  complexity: number;
  coupling: number;
  churn: number;
  duplication: number;
  state: number;
  clumping: number;
  deadcode: number;
  architecture: number;
  reach: number;
  magic: number;
  guard: number;
}

export interface ArchViolation {
  from: string;
  to: string;
  from_layer: string;
  to_layer: string;
}

export interface AnalysisResult {
  // v2: state; v3: clumping; v4: deadcode+architecture+reach; v5: magic;
  // v6: weighted/trending churn, files_skipped, hotspot why-strings;
  // v7: guard (shared-condition / consolidate-conditional-expression) signal
  version: 7;
  repository: { name: string; commit: string; path: string };
  timestamp: string;
  files_analyzed: number;
  files_skipped: string[]; // paths that failed to read (permissions, deleted mid-run, non-UTF8)
  files_by_language: Record<string, number>;
  summary: Summary;
  files: FileMetrics[];
  hotspots: FileMetrics[];
  cycles: string[][];
  architecture_violations: ArchViolation[]; // capped at 100
  trend: { delta: number | null; velocity: number | null };
}

export interface EntropyConfig {
  // Weights are normalized by their sum at scoring time, so configs that
  // don't sum to 1 (e.g. pre-state configs missing state_weight) stay sane.
  entropy: {
    complexity_weight: number;
    coupling_weight: number;
    churn_weight: number;
    duplication_weight: number;
    state_weight: number;
    clumping_weight: number;
    deadcode_weight: number;
    architecture_weight: number;
    reach_weight: number;
    magic_weight: number;
    guard_weight: number;
  };
  analysis: { since: string };
  // Layer names inner→outer, matched against path segments. A file in an
  // inner layer importing an outer one is a violation (hexagonal direction).
  // Files whose path matches no layer are exempt.
  architecture: { layers: string };
  hotspots: {
    limit: number;
    complexity_weight: number;
    coupling_weight: number;
    churn_weight: number;
  };
  // Normalization caps: raw value that maps to score 100 (linear, clamped).
  // Engineering heuristics, not universal constants — tune per codebase.
  scoring: {
    complexity_avg_cap: number;
    complexity_max_cap: number;
    coupling_cap: number;
    churn_commits_cap: number;
    churn_per_line_cap: number;
    state_fields_cap: number; // optional+bool fields in ONE type scoring 100 (~2^cap states)
    clump_fields_cap: number; // same-prefix fields in ONE type scoring 100
    arch_violations_cap: number; // inner→outer imports in ONE file scoring 100
    reach_percent_cap: number; // % of repo transitively depending on ONE file scoring 100
    magic_per_100loc_cap: number; // magic literals per 100 LOC scoring 100 (density, not raw count)
    guard_group_cap: number; // sibling ifs in ONE shared-guard group scoring 100
  };
}

export const DEFAULT_CONFIG: EntropyConfig = {
  entropy: {
    complexity_weight: 0.2,
    coupling_weight: 0.2,
    churn_weight: 0.15,
    duplication_weight: 0.1,
    state_weight: 0.1,
    clumping_weight: 0.1,
    deadcode_weight: 0.05,
    architecture_weight: 0.05,
    reach_weight: 0.05,
    magic_weight: 0.05,
    guard_weight: 0.05,
  },
  analysis: { since: "30d" },
  architecture: { layers: "domain, application, infrastructure, api" },
  hotspots: {
    limit: 20,
    complexity_weight: 0.35,
    coupling_weight: 0.35,
    churn_weight: 0.3,
  },
  scoring: {
    complexity_avg_cap: 10,
    complexity_max_cap: 30,
    coupling_cap: 20,
    churn_commits_cap: 10,
    churn_per_line_cap: 1.0,
    state_fields_cap: 6,
    clump_fields_cap: 6,
    arch_violations_cap: 3,
    reach_percent_cap: 25,
    magic_per_100loc_cap: 5,
    guard_group_cap: 4,
  },
};
