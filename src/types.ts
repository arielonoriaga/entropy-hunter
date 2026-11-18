// Layered data model: raw facts (deterministic measurements) vs derived
// scores (deterministic normalization). Interpretation is deliberately out
// of scope — that layer belongs to a future agent consuming the JSON.

export interface FunctionComplexity {
  name: string;
  complexity: number;
  line: number;
  end_line: number;
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
  duplicate_partners: string[]; // files sharing the most cloned windows with this one (max 5)
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
  // Deepest control-flow nesting: if/for/while/match/try blocks inside one
  // another. Function bodies, closures and literals do not count. Deep
  // nesting is what guard clauses and early returns flatten.
  max_nesting: number;
  nesting_line: number; // where that depth is first reached (0 if none)
  // Test coverage presence (not quality): does this file have a companion
  // test (or, for Rust, an inline #[cfg(test)] module)?
  has_test: boolean;
  test_path: string; // companion path, "(inline)" for Rust, "" if none
  // Nested optionality (Option<Option<T>>, deeper): each layer beyond the
  // first hides an additional implicit state a caller must distinguish.
  // Rust struct fields only (see design doc); TypeScript/generic analyzers
  // report 0/false.
  max_optional_depth: number; // worst single field's depth in this file (0 = none nested)
  nested_optional_occurrences: number; // count of nested-Option regex matches across the file
  nested_optional_pub: boolean; // does ANY pub struct in this file have depth >= 1?
  // Graph-derived (recomputed each run, not content-cached):
  // Magic literals: unnamed numbers in logic, strings in comparisons/arms.
  magic_numbers: number;
  magic_strings: number;
  is_entrypoint: boolean; // main/lib/index/bin/tests — legitimately importless
  is_orphan: boolean; // fan_in == 0 and not an entrypoint: likely dead
  in_cycle: boolean; // part of a dependency cycle (a strongly connected group of 2+ files)
  transitive_dependents: number; // files that can break when this one changes
  arch_violations: number; // imports that point inner→outer against [architecture] layers
  comment_lines: number[];
}

// The signals blended into the Entropy Index, in scoring order. Each has a
// `<name>_score` per file, a `<name>` entry in the summary and a
// `<name>_weight` in `[entropy]` — this list is the single source for all three.
export const SIGNALS = [
  "complexity", "coupling", "churn", "duplication", "state", "clumping",
  "deadcode", "architecture", "reach", "magic", "guard", "test", "semantic", "nesting",
] as const;
export type Signal = (typeof SIGNALS)[number];

// Control flow this deep is ordinary (a loop with a condition in it) and
// scores 0; the nesting score rises linearly from here to nesting_depth_cap.
export const FREE_NESTING = 2;

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
  // 0 if tested or trivial (no complexity to protect); otherwise scales
  // with how much untested complexity/logic this file exposes.
  test_score: number;
  semantic_score: number;
  nesting_score: number;
  // One sentence naming the dominant raw fact behind hotspot_score, so an
  // agent (or human) doesn't have to reverse-engineer which signal fired.
  why: string;
  hotspot_score: number;
  entropy_contribution: number;
  // Same weighted-mean-of-13-signals formula as summary.entropy, but
  // computed per file and NOT LOC-weighted — how bad this file is in
  // isolation, so a small nasty file scores as badly as a big one.
  entropy_score: number;
  // entropy_score * (% of repo transitively depending on this file) — how
  // dangerous, not just how messy: high entropy with no reach is low risk.
  priority_score: number;
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
  test: number;
  semantic: number;
  nesting: number;
  // 95th percentile of per-file entropy_score — "how bad are the worst
  // files", independent of the LOC-weighting that entropy_index uses.
  p95_file_entropy: number;
  // Count of files whose priority_score >= [priority] critical_threshold.
  critical_hotspots: number;
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
  // v7: guard (shared-condition) signal; v8: test-coverage-presence signal;
  // v9: entropy_score/priority_score per file, p95_file_entropy/critical_hotspots summary;
  // v10: semantic (nested-optionality) signal; v11/v12: analyzer refinements
  version: 14;
  repository: { name: string; commit: string; path: string };
  timestamp: string;
  files_analyzed: number;
  files_skipped: string[]; // paths that failed to read (permissions, deleted mid-run, non-UTF8)
  files_by_language: Record<string, number>;
  summary: Summary;
  files: FileMetrics[];
  hotspots: FileMetrics[];
  priority: FileMetrics[]; // top files by priority_score (entropy_score * reach%), capped at [hotspots] limit
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
    test_weight: number;
    semantic_weight: number;
    nesting_weight: number;
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
  // priority_score (entropy_score * reach%) at/above this counts toward
  // summary.critical_hotspots.
  priority: { critical_threshold: number };
  // `entropy check` thresholds: what counts as a regression in a changed file.
  gate: {
    max_file_delta: number; // entropy_score rise (points) that fails an existing file
    new_file_entropy: number; // entropy_score a brand-new file may not start at
    function_complexity: number; // a function may not grow past this complexity
    new_duplicated_lines: number; // newly duplicated lines that fail
    nesting_depth: number; // control-flow nesting may not grow past this depth
    comments: boolean;
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
    test_complexity_cap: number; // complexity_total of an untested file scoring 100
    semantic_depth_cap: number; // max_optional_depth in ONE file scoring 100
    semantic_frequency_cap: number; // nested_optional_occurrences in ONE file scoring 100
    nesting_depth_cap: number; // max_nesting scoring 100; the first FREE_NESTING levels score 0
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
    test_weight: 0.1,
    semantic_weight: 0.05,
    nesting_weight: 0.05,
  },
  analysis: { since: "30d" },
  architecture: { layers: "domain, application, infrastructure, api" },
  hotspots: {
    limit: 20,
    complexity_weight: 0.35,
    coupling_weight: 0.35,
    churn_weight: 0.3,
  },
  priority: { critical_threshold: 20 },
  gate: {
    max_file_delta: 5,
    new_file_entropy: 30,
    function_complexity: 15,
    new_duplicated_lines: 6,
    nesting_depth: 4,
    comments: true,
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
    test_complexity_cap: 20,
    semantic_depth_cap: 3,
    semantic_frequency_cap: 8,
    nesting_depth_cap: 6,
  },
};
