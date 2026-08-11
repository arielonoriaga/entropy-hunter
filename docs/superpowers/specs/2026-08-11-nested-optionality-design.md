# Nested Optionality (Semantic Ambiguity) Signal

## Motivation

`Option<Option<T>>` (and deeper nesting) is not inherently bad — it can be a
legitimate PATCH-style tri-state (`None` = don't touch, `Some(None)` =
clear, `Some(Some(v))` = set). But it hides N implicit states behind a type
that reads like one thing. The analyzer should surface where this pattern
concentrates, without ever calling it "bad code."

## Scope (v1)

- **Rust only.** `Option<Option<T>>` is syntactically unambiguous to detect.
  TypeScript's `T | null | undefined` has more shape variants (union
  ordering, `?:` vs explicit `| undefined`) and deserves its own pass later.
- **Struct fields only**, weighted by whether the struct is `pub` (a public
  API/DTO surface) vs private. Function parameters and local variables are
  out of scope — no existing signal parses function bodies/param lists for
  types, and adding that is a separate, larger effort.
- Explicit state enums (`enum FieldUpdate<T> { Unchanged, Clear, Set(T) }`)
  are automatically exempt: `stateSpace` already only scans `struct` bodies,
  never `enum` — no extra detection code needed for this exemption.

## Detection

In `src/languages/rust.ts`, extend `stateSpace`:

1. A struct is "public" if its header matches `pub struct Name` (a separate
   regex scan over the file, collected into a `Set<string>` of pub struct
   names — `extractBraceBlocks`'s single-capture-group contract doesn't fit
   a second visibility group cleanly, so this stays a standalone lookup).
2. Within each struct's body, find contiguous `Option<Option<...` runs via
   `/Option\s*<\s*Option\s*<(?:\s*Option\s*<)*/g`. A run's `Option` count
   − 1 = its **depth** (bare `Option<T>` has depth 0 and is exempt — this
   matches the spec's `states = depth + 2` table: depth 0 → 2 states
   (normal optional), depth 1 → 3 states, depth 2 → 4 states).
3. Per type: `max_optional_depth` (worst field in this type),
   `nested_optional_count` (fields in this type with depth ≥ 1).

## New raw facts (`FileFacts`)

- `max_optional_depth: number` — worst single field's depth in this file (0
  = no nested optionality).
- `nested_optional_fields: number` — count of fields across the file with
  depth ≥ 1.
- `nested_optional_pub: boolean` — is the struct that produced the worst
  depth a `pub` struct?

`TypeState` (the per-language-analyzer contract) gains
`max_optional_depth?: number` and `nested_optional_count?: number` as
**optional** fields, so `typescript.ts`/`generic.ts` need no changes in
this iteration — the aggregation in `analyze.ts` defaults missing values to
0 via `?? 0`.

## New score: `semantic_score`

Same shape as `state_score`/`guard_score` (worst-in-file drives the base,
plus a frequency and visibility adjustment — not a flat per-occurrence
penalty, so one nested `Option` in an otherwise clean file stays low):

```
raw   = 0.6 · norm(max_optional_depth, semantic_depth_cap)
      + 0.4 · norm(nested_optional_fields, semantic_frequency_cap)
score = round1(min(100, raw × (nested_optional_pub ? semantic_pub_multiplier : 1)))
```

Defaults: `semantic_depth_cap = 3`, `semantic_frequency_cap = 8`,
`semantic_pub_multiplier = 1.5`. A single private `Option<Option<String>>`
scores ~20 (depth 1 of cap 3, count 1 of cap 8: 0.6·33.3 + 0.4·12.5 ≈ 25);
frequent + deep + public pushes toward 100.

Interaction with other signals (complexity, state, coupling, churn) is
inherited for free through the existing weighted-mean entropy formula — the
same mechanism every other signal already uses. No special cross-term.

## Wiring (mechanical — mirrors the `guard`/`test` signals exactly)

- `EntropyConfig.entropy.semantic_weight`,
  `scoring.semantic_depth_cap`/`semantic_frequency_cap`/`semantic_pub_multiplier`.
- `FileScores.semantic_score`, `Summary.semantic`.
- `AnalysisResult.version` → 10 (bump comment documents `v10`).
- `CACHE_VERSION` → `v9` in `analyze.ts` (cached `base.st` shape changes).
- `health.ts`: add `semantic: "Semantic"` to `SIGNAL_LABELS` and
  `signalKeys`.
- `report.ts`: "Semantic ambiguity" section in `renderFile` (mirrors "Data
  clumps"/"Guard clumps"); `Semantic:` row in `renderAnalysis` and the
  summary table in `renderMarkdown`.
- README: new row in the "How scores are derived" table, weight default
  update, `SIGNAL_LABELS`/health doc note (12 signals → 13).

## Tests

- `languages.test.ts` — unit coverage for the exact list from the original
  request: `Option<String>` (depth 0, exempt), `Option<Option<String>>`
  (depth 1), `Option<Option<Option<String>>>` (depth 2),
  `Option<Result<String, E>>` (not nested-Option), `Result<Option<String>,
  E>` (not nested-Option), `Vec<Option<String>>` (not nested-Option), and
  the `enum FieldUpdate<T>` false-positive case (must NOT be flagged).
- `analyze.test.ts` — a new `fixtures/rust/nested-optionality/` fixture
  (mirrors the shape of `fixtures/rust/stateful/`) exercising scoring +
  summary integration: isolated occurrence, repeated occurrence, public vs
  private struct.

## Validation

After implementation, run `entropy analyze` against
`/home/ariel/Projects/Personal/ez-stock/backend` (a real Rust codebase
already confirmed to contain `Option<Option<...>>` usage in
`shared/patch.rs`, `contexts/purchases/domain.rs`, and others) as a
real-world sanity check that the signal fires where expected and doesn't
false-positive elsewhere.
