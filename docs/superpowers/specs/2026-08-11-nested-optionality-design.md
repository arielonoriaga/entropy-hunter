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

1. A struct is "public" if its header matches `pub struct Name` — a
   separate regex scan over the file (`/\bpub\s+struct\s+([A-Za-z_]\w*)/g`,
   deliberately **not** matching `pub(crate) struct`/`pub(super) struct`,
   since those aren't public API), collected into a `Set<string>` of pub
   struct names. `extractBraceBlocks`'s single-capture-group contract
   doesn't fit a second visibility group cleanly, so this stays a
   standalone lookup. **Known limitation, accepted (regex heuristic, not
   AST-exact, same spirit as the existing complexity/dependency proxies):**
   this is name-based, not scope-based, so two same-named structs in
   different `mod` blocks (one `pub`, one private) will be conflated. Rare
   in practice; call out if it proves noisy in the ez-stock validation run.
2. Within each struct's body, find contiguous `Option<Option<...` runs via
   `/Option\s*<\s*Option\s*<(?:\s*Option\s*<)*/g`. A run's `Option` count
   − 1 = its **depth** (bare `Option<T>` has depth 0 and is exempt — this
   matches the spec's `states = depth + 2` table: depth 0 → 2 states
   (normal optional), depth 1 → 3 states, depth 2 → 4 states).
3. Per type: `max_optional_depth` (worst field in this type),
   `nested_optional_occurrences` (count of *matches*, i.e. `Option<Option<`
   runs, not fields — a single field of type `HashMap<Option<Option<K>>,
   Option<Option<V>>>` counts as 2 occurrences, since the regex can't
   attribute runs back to one field boundary without full field-splitting,
   which is out of scope for v1. Named `_occurrences`, not `_fields`, to be
   honest about what's counted).
4. **Explicitly out of scope, not detected:** tuple structs
   (`struct Patch(Option<Option<T>>);`) — the existing struct header regex
   (`rust.ts`'s `/\bstruct\s+([A-Za-z_]\w*)[^{;(]*\{/g`) already excludes
   them via `[^{;(]*` (stops before a `(`), consistent with today's
   struct-field-only scanning. `Vec<Option<T>>` / `HashMap<K, Option<V>>` /
   `Result<Option<T>, E>` / `Option<Box<Option<T>>>` — none of these are
   *directly* nested `Option<Option<...>>`, so none match; this is
   intentional; the spec's own test list confirms these should NOT fire.

## New raw facts (`FileFacts`)

- `max_optional_depth: number` — worst single field's depth in this file (0
  = no nested optionality).
- `nested_optional_occurrences: number` — count of nested-Option runs across
  the file (see caveat above: occurrences, not distinct fields).
- `nested_optional_pub: boolean` — is there **any** `pub` struct in this
  file with `max_optional_depth ≥ 1`? (Not "is the single worst-depth type
  pub" — that definition let six pub structs at depth 1 plus one private
  struct at depth 2 report `pub = false`, hiding the public-surface signal
  entirely. Tracked as its own independent reduction over all types, not
  derived from whichever type happens to hold the file's max depth.)

`TypeState` (the per-language-analyzer contract) gains
`max_optional_depth: number` and `nested_optional_occurrences: number` as
**required** fields — matching how every existing `TypeState` field
(`clump_fields`, `clump_prefix`, etc.) has always been required. No
per-language analyzer has ever partially implemented `TypeState`;
`generic.ts` opts out wholesale via `stateSpace: () => []`, and `rust.ts`/
`typescript.ts` both implement every field. Keep that precedent:
`typescript.ts`'s `stateSpace` map gets `max_optional_depth: 0,
nested_optional_occurrences: 0` added to its returned object (TypeScript's
own union-based nested-optionality detection is out of scope for v1, per
the design's own scope section — these are honest zeros, not a shortcut).

## New score: `semantic_score`

Same "worst-in-file drives the base" shape as `state_score`/`guard_score`,
extended with a frequency term and an **additive** (not multiplicative)
visibility term — a multiplier applied after the blend either vanishes
(anything blending ≥ ~67 clamps to 100 regardless of visibility) or, at the
low end, can push a single legitimate PATCH-style public field further into
the ATTENTION band than a flat additive term would. An additive term stays
proportionate across the whole range:

```
raw   = 0.55 · norm(max_optional_depth, semantic_depth_cap)
      + 0.30 · norm(nested_optional_occurrences, semantic_frequency_cap)
      + 0.15 · (nested_optional_pub ? 100 : 0)
score = round1(min(100, raw))
```

Defaults: `semantic_depth_cap = 3`, `semantic_frequency_cap = 8`,
`semantic_weight = 0.05` (matching `guard_weight`/`magic_weight`).

Worked examples: a single private `Option<Option<String>>` (depth 1, count
1) → `0.55·33.3 + 0.30·12.5 ≈ 22` — stays below health.ts's 30 ATTENTION
band, matching "shouldn't tank a clean module." The same field in a `pub`
struct → `22 + 15 = 37` — crosses into low ATTENTION, which is *intended*:
the original request's contextual-weighting ladder explicitly wants public
API/DTO occurrences to read as more significant than private ones, not
identical. Frequent + deep + public pushes toward 100 without ever fully
suppressing the visibility signal, unlike the multiplicative form.

No `is_orphan`/entrypoint exemption applies here (unlike `magic_score`,
which exempts test files, or `test_score`, which exempts entrypoints) —
nested optionality in a struct is equally worth surfacing regardless of
whether the file itself is reachable or a test.

Interaction with other signals (complexity, state, coupling, churn) is
inherited for free through the existing weighted-mean entropy formula — the
same mechanism every other signal already uses. No special cross-term.

## Wiring (mechanical — mirrors the `guard`/`test` signals exactly)

- `EntropyConfig.entropy.semantic_weight` (default 0.05),
  `scoring.semantic_depth_cap`/`semantic_frequency_cap`.
- `FileScores.semantic_score`, `Summary.semantic`.
- `AnalysisResult.version` → 10 (bump comment documents `v10`).
- `CACHE_VERSION` → `v9` in `analyze.ts` (cached `base.st` shape changes;
  comment names the new fields, matching the `v8` comment's style).
- `analyze.ts` touchpoints (five sites per existing signal, confirmed by
  tracing how `guard`/`test` were wired): `entropyWeightSum`, the per-file
  `fileEntropy` weighted sum, the `wmean`-based `summary` object, the
  **empty-repo `Summary` literal fallback**, and the final `summary.entropy`
  weighted sum.
- `storage.ts`: `snapshots` table needs `ALTER TABLE … ADD COLUMN semantic
  REAL NOT NULL DEFAULT 0`; `file_metrics` table needs 4 new columns
  (`max_optional_depth`, `nested_optional_occurrences`, `nested_optional_pub`,
  `semantic_score`); `saveSnapshot`'s column list AND its hand-counted
  `VALUES (?,?,…)` placeholder string both grow — easy to silently
  misalign, verify placeholder count matches column count after editing.
- `health.ts`: add `semantic: "Semantic"` to `SIGNAL_LABELS` and
  `signalKeys`.
- `report.ts`: "Semantic ambiguity" section in `renderFile` (mirrors "Data
  clumps"/"Guard clumps"); `Semantic:` row in `renderAnalysis` and the
  summary table in `renderMarkdown`.
- README: new row in the "How scores are derived" table, weight default
  update, and the "any of the 12 summary signals" line → 13.

## Tests

- `languages.test.ts` — unit coverage for the exact list from the original
  request: `Option<String>` (depth 0, exempt), `Option<Option<String>>`
  (depth 1), `Option<Option<Option<String>>>` (depth 2),
  `Option<Result<String, E>>` (not nested-Option), `Result<Option<String>,
  E>` (not nested-Option), `Vec<Option<String>>` (not nested-Option), and
  the `enum FieldUpdate<T>` false-positive case (must NOT be flagged). Also
  cover: `pub(crate) struct` is NOT treated as public; a field with two
  independent nested-Option occurrences in one composite type is counted as
  2 occurrences, not 1.
- `analyze.test.ts` — a new `fixtures/rust/nested-optionality/` fixture
  (mirrors the shape of `fixtures/rust/stateful/`) exercising scoring +
  summary integration: isolated occurrence, repeated occurrence, public vs
  private struct.
- `storage.test.ts` — snapshot round-trip still passes with the 4 new
  columns (catches column/placeholder misalignment immediately rather than
  at first real use).

## Validation

After implementation, ran `entropy analyze` against
`/home/ariel/Projects/Personal/ez-stock/backend` (a real Rust codebase) as a
real-world sanity check. It found 13-14 files with genuine struct-field
nested-Option usage, all correctly classified by pub/private and occurrence
count, with zero false positives and zero unexpected false negatives.

An earlier naive grep had also flagged `shared/patch.rs` and
`contexts/purchases/domain.rs` as `Option<Option<...>>` occurrences, but
neither actually belongs in the detector's output: `patch.rs`'s only
occurrence sits inside a `//!` doc comment (comments are stripped before
detection), and `domain.rs`'s two occurrences are both function parameters
on a trait method, not struct fields (v1 is struct-fields-only; function
parameters are explicitly out of scope, see Scope above). Both were
correctly excluded by the detector — these aren't misses to chase.
