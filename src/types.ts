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
}

export interface FileScores {
  complexity_score: number;
  coupling_score: number;
  churn_score: number;
  duplication_score: number;
  state_score: number;
  clumping_score: number;
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
}

export interface AnalysisResult {
  version: 3; // v2: state signal (state-space exposure); v3: clumping signal (data clumps)
  repository: { name: string; commit: string; path: string };
  timestamp: string;
  files_analyzed: number;
  files_by_language: Record<string, number>;
  summary: Summary;
  files: FileMetrics[];
  hotspots: FileMetrics[];
  cycles: string[][];
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
  };
  analysis: { since: string };
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
  };
}

export const DEFAULT_CONFIG: EntropyConfig = {
  entropy: {
    complexity_weight: 0.25,
    coupling_weight: 0.25,
    churn_weight: 0.2,
    duplication_weight: 0.1,
    state_weight: 0.1,
    clumping_weight: 0.1,
  },
  analysis: { since: "30d" },
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
  },
};
