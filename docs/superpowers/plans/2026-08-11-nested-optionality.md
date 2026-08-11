# Nested Optionality (Semantic Ambiguity) Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 13th entropy signal (`semantic`) that detects nested Rust `Option<Option<T>>` (and deeper) struct fields as a source of implicit semantic ambiguity, weighted by nesting depth, frequency, and public-API visibility.

**Architecture:** Follows the exact existing pattern used for every prior signal (`guard`, `test`, etc.): a language analyzer produces raw facts (`src/languages/rust.ts`), `analyze.ts` aggregates and scores them, `types.ts` defines the schema, and `storage.ts`/`health.ts`/`report.ts`/README consume the new fields the same way they consume every other signal. Rust-only in this iteration; `TypeState` stays a fully-required interface (no per-language opt-outs beyond the existing wholesale `generic.ts` one).

**Tech Stack:** TypeScript, Bun (test runner + sqlite), regex-based source analysis (no AST).

## Global Constraints

- Design doc (source of truth for every formula/field name in this plan): `docs/superpowers/specs/2026-08-11-nested-optionality-design.md`.
- Rust only. Struct fields only. No function-parameter or local-variable detection.
- `pub(crate)`/`pub(super)` structs are NOT treated as public — only bare `pub struct`.
- `TypeState` fields are **required**, not optional — every analyzer implements every field (matches existing precedent).
- New raw fact is named `nested_optional_occurrences`, not `..._fields` (it counts regex matches, which can exceed field count for composite generic types).
- Score formula is **additive**, not multiplicative: `raw = 0.55·norm(max_optional_depth, semantic_depth_cap) + 0.30·norm(nested_optional_occurrences, semantic_frequency_cap) + 0.15·(nested_optional_pub ? 100 : 0)`, `score = round1(min(100, raw))`.
- Defaults: `semantic_depth_cap = 3`, `semantic_frequency_cap = 8`, `semantic_weight = 0.05`.
- `nested_optional_pub` = true if **any** `pub` struct in the file has `max_optional_depth ≥ 1` (not "is the single worst-depth type pub").
- No `is_orphan`/entrypoint exemption for this signal.
- Run all tests with `bun test` from the repo root (`/home/ariel/Projects/Personal/entropy-hunter`).

---

### Task 1: Rust nested-Option detection + `TypeState` contract

**Files:**
- Modify: `src/languages/analyzer.ts` (`TypeState` interface, ~line 20-26)
- Modify: `src/languages/rust.ts` (`stateSpace`, ~line 131-146)
- Modify: `src/languages/typescript.ts` (`stateSpace`, ~line 135-153) — add zero defaults, no detection logic
- Test: `tests/languages.test.ts`

**Interfaces:**
- Produces: `TypeState.max_optional_depth: number`, `TypeState.nested_optional_occurrences: number`, `TypeState.is_pub: boolean` (all required, consumed by Task 2's `analyze.ts` aggregation).

- [ ] **Step 1: Write the failing unit tests**

Add to `tests/languages.test.ts`, inside (or right after) the existing `describe("state-space and clump extraction", ...)` block (after the existing tests, before the closing `});` at line 126):

```typescript
describe("nested optionality detection", () => {
  test("rust: Option<T> alone is depth 0 (exempt)", () => {
    const types = rustAnalyzer.stateSpace("pub struct P { pub name: Option<String> }");
    expect(types[0]).toMatchObject({ max_optional_depth: 0, nested_optional_occurrences: 0 });
  });

  test("rust: Option<Option<T>> is depth 1", () => {
    const types = rustAnalyzer.stateSpace("struct P { name: Option<Option<String>> }");
    expect(types[0]).toMatchObject({ max_optional_depth: 1, nested_optional_occurrences: 1 });
  });

  test("rust: Option<Option<Option<T>>> is depth 2", () => {
    const types = rustAnalyzer.stateSpace("struct P { name: Option<Option<Option<String>>> }");
    expect(types[0]).toMatchObject({ max_optional_depth: 2, nested_optional_occurrences: 1 });
  });

  test("rust: Option<Result<T, E>> and Result<Option<T>, E> and Vec<Option<T>> are NOT nested-Option", () => {
    const src = `
      struct A { a: Option<Result<String, u32>> }
      struct B { b: Result<Option<String>, u32> }
      struct C { c: Vec<Option<String>> }
    `;
    const types = rustAnalyzer.stateSpace(src);
    for (const t of types) {
      expect(t.max_optional_depth).toBe(0);
      expect(t.nested_optional_occurrences).toBe(0);
    }
  });

  test("rust: explicit enum state modeling is not flagged (enums are never scanned)", () => {
    const src = `
      enum FieldUpdate<T> {
        Unchanged,
        Clear,
        Set(T),
      }
    `;
    const types = rustAnalyzer.stateSpace(src);
    expect(types).toEqual([]);
  });

  test("rust: a composite field with two independent nested-Option occurrences counts as 2", () => {
    const src = "struct M { m: HashMap<Option<Option<u32>>, Option<Option<String>>> }";
    const types = rustAnalyzer.stateSpace(src);
    expect(types[0]).toMatchObject({ max_optional_depth: 1, nested_optional_occurrences: 2 });
  });

  test("rust: pub struct is public, pub(crate) struct is not", () => {
    const src = `
      pub struct Public { pub name: Option<Option<String>> }
      pub(crate) struct Internal { pub name: Option<Option<String>> }
    `;
    const types = rustAnalyzer.stateSpace(src);
    expect(types[0]).toMatchObject({ name: "Public", max_optional_depth: 1, is_pub: true });
    expect(types[1]).toMatchObject({ name: "Internal", max_optional_depth: 1, is_pub: false });
  });

  test("rust: tuple structs are not scanned (existing struct-header regex already excludes them)", () => {
    const types = rustAnalyzer.stateSpace("pub struct Patch(Option<Option<String>>);");
    expect(types).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/languages.test.ts -t "nested optionality detection"`
Expected: FAIL — `max_optional_depth`/`nested_optional_occurrences` don't exist on the returned objects yet (they'll be `undefined`, so `toMatchObject` fails).

- [ ] **Step 3: Add the two fields to `TypeState`**

In `src/languages/analyzer.ts`, extend the `TypeState` interface (currently lines 20-26):

```typescript
export interface TypeState {
  name: string;
  optional_fields: number;
  boolean_fields: number;
  clump_fields: number; // size of the largest same-prefix field group (0 if < MIN_CLUMP)
  clump_prefix: string; // that group's prefix ("" if none)
  // Nested optionality (Option<Option<T>>, deeper): each layer beyond the
  // first hides an additional implicit state. depth 0 = plain Option<T>,
  // exempt (matches semantic_states = depth + 2 from the design doc).
  max_optional_depth: number; // worst field in this type
  nested_optional_occurrences: number; // count of nested-Option regex
  // matches in this type's body — NOT distinct fields: a single field of
  // type HashMap<Option<Option<K>>, Option<Option<V>>> counts as 2.
}
```

- [ ] **Step 4: Implement detection in `rust.ts`**

In `src/languages/rust.ts`, add a module-level regex constant near the top (alongside `FN_HEADER`/`DECISION`, currently lines 8-11):

```typescript
// Contiguous "Option<Option<...Option<" runs — a run's Option-count minus 1
// is its nesting depth beyond the first (unremarkable) layer.
const NESTED_OPTION = /Option\s*<\s*Option\s*<(?:\s*Option\s*<)*/g;
// Public API surface: `pub struct Name` only — pub(crate)/pub(super) are
// crate-internal, not public API, and must NOT match here.
const PUB_STRUCT = /\bpub\s+struct\s+([A-Za-z_]\w*)/g;
```

Replace the `stateSpace` method (currently lines 131-146) with:

```typescript
  stateSpace(source) {
    const src = stripped(source);
    const pubStructs = new Set([...src.matchAll(PUB_STRUCT)].map((m) => m[1]));
    // Struct fields only; enums are the fix, not the smell.
    return extractBraceBlocks(
      src,
      /\bstruct\s+([A-Za-z_]\w*)[^{;(]*\{/g,
    ).map(({ name, body }) => {
      const clump = largestPrefixClump(fieldNames(body));
      const nestedMatches = [...body.matchAll(NESTED_OPTION)];
      const maxDepth = nestedMatches.reduce(
        (best, m) => Math.max(best, (m[0].match(/Option/g)!.length) - 1),
        0,
      );
      return {
        name,
        optional_fields: (body.match(/:\s*Option\s*</g) ?? []).length,
        boolean_fields: (body.match(/:\s*bool\b/g) ?? []).length,
        clump_fields: clump.fields,
        clump_prefix: clump.prefix,
        max_optional_depth: maxDepth,
        nested_optional_occurrences: nestedMatches.length,
      };
    });
  },
```

Note: `pubStructs` is computed but not yet used inside the returned objects — file-level pub-ness aggregation (which struct names are public) happens in Task 2's `analyze.ts`, which needs access to the pub-struct set per type. Extend the return shape to carry it:

```typescript
      return {
        name,
        optional_fields: (body.match(/:\s*Option\s*</g) ?? []).length,
        boolean_fields: (body.match(/:\s*bool\b/g) ?? []).length,
        clump_fields: clump.fields,
        clump_prefix: clump.prefix,
        max_optional_depth: maxDepth,
        nested_optional_occurrences: nestedMatches.length,
        is_pub: pubStructs.has(name),
      };
```

This means `TypeState` needs one more field: `is_pub: boolean`. Go back and add it to the interface in Step 3:

```typescript
  max_optional_depth: number;
  nested_optional_occurrences: number;
  is_pub: boolean; // is this type's declaration `pub` (public API surface)?
```

And in `src/languages/typescript.ts`, add the three new fields with honest defaults to the object returned inside `stateSpace`'s `.map(...)` (currently lines 143-151) — TypeScript's own nested-optionality/visibility detection is out of scope for v1:

```typescript
      return {
        name,
        optional_fields:
          (body.match(/[\w$\])]\?\s*:/g) ?? []).length +
          (body.match(/\|\s*(?:null|undefined)\b/g) ?? []).length,
        boolean_fields: (body.match(/:\s*boolean\b/g) ?? []).length,
        clump_fields: clump.fields,
        clump_prefix: clump.prefix,
        max_optional_depth: 0,
        nested_optional_occurrences: 0,
        is_pub: false,
      };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/languages.test.ts -t "nested optionality detection"`
Expected: PASS (all 8 new tests).

- [ ] **Step 6: Run the full existing language test suite to check for regressions**

Run: `bun test tests/languages.test.ts`
Expected: PASS — the existing `toMatchObject` assertions on `stateSpace` results (lines 100, 102, 108-109, 113-118, 124) use partial matching, so the three new fields don't break them.

- [ ] **Step 7: Commit**

```bash
git add src/languages/analyzer.ts src/languages/rust.ts src/languages/typescript.ts tests/languages.test.ts
git commit -m "feat: detect nested Option<Option<T>> struct fields (semantic ambiguity)"
```

---

### Task 2: Schema, aggregation, and scoring in `types.ts` / `analyze.ts`

**Files:**
- Modify: `src/types.ts` (`FileFacts`, `FileScores`, `Summary`, `EntropyConfig`, `DEFAULT_CONFIG`, `AnalysisResult.version`)
- Modify: `src/analyze.ts` (`CachedBase`, `CACHE_VERSION`, fact population, scoring pass, summary)
- Modify: `fixtures/rust/stateful/src/lib.rs` — NOT modified (leave as-is; new fixture added separately below)
- Create: `fixtures/rust/nested-optionality/src/lib.rs`
- Test: `tests/analyze.test.ts`

**Interfaces:**
- Consumes: `TypeState.max_optional_depth`, `TypeState.nested_optional_occurrences`, `TypeState.is_pub` from Task 1.
- Produces: `FileFacts.max_optional_depth: number`, `FileFacts.nested_optional_occurrences: number`, `FileFacts.nested_optional_pub: boolean`, `FileScores.semantic_score: number`, `Summary.semantic: number`. These are consumed by Task 3 (storage), Task 4 (health), Task 5 (report).

- [ ] **Step 1: Create the fixture**

Create `fixtures/rust/nested-optionality/src/lib.rs`:

```rust
// Legitimate PATCH tri-state on a public DTO: None = don't touch, Some(None)
// = clear, Some(Some(v)) = set. One occurrence, depth 1, public.
pub struct UpdateUser {
    pub name: Option<Option<String>>,
    pub email: String,
}

// A private, deeply-nested field: depth 2, not public.
struct InternalCache {
    entry: Option<Option<Option<u64>>>,
}

// Not nested optionality at all: Vec<Option<T>>, Option<Result<T, E>> are
// exempt by design (only direct Option<Option<...>> chains count).
pub struct Listing {
    pub items: Vec<Option<String>>,
    pub fallback: Option<Result<String, u32>>,
}
```

- [ ] **Step 2: Write the failing integration tests**

Add to `tests/analyze.test.ts`, after the existing `test("clumping signal: ...")` block (after line 172, before the `test("coupling: ...")` block):

```typescript
  test("semantic signal: nested Option depth/occurrences/pub detected and scored", () => {
    const nested = result.files.find((f) => f.path === "rust/nested-optionality/src/lib.rs")!;
    expect(nested.max_optional_depth).toBe(2); // InternalCache: Option<Option<Option<u64>>>
    expect(nested.nested_optional_occurrences).toBe(2); // UpdateUser.name + InternalCache.entry
    expect(nested.nested_optional_pub).toBe(true); // UpdateUser is pub with depth 1
    expect(nested.semantic_score).toBeGreaterThan(0);
    const clean = result.files.find((f) => f.path === "rust/simple/src/lib.rs")!;
    expect(clean.max_optional_depth).toBe(0);
    expect(clean.nested_optional_occurrences).toBe(0);
    expect(clean.nested_optional_pub).toBe(false);
    expect(clean.semantic_score).toBe(0);
  });
```

Update the existing hardcoded expectations that this new fixture shifts (the fixture adds one new `.rs` file, so `files_analyzed` and `files_by_language.rust` both go up by 1):

In `test("finds dedicated and generic-fallback languages", ...)` (currently lines 62-67):

```typescript
  test("finds dedicated and generic-fallback languages", () => {
    expect(result.files_by_language.rust).toBe(11);
    expect(result.files_by_language.typescript).toBe(13);
    expect(result.files_by_language.python).toBe(2); // generic fallback
    expect(result.files_analyzed).toBe(26);
  });
```

Append `"semantic"` to every `keys`/signal-name array that enumerates all summary/score signals — there are three such arrays:

1. `test("entropy index is the weight-sum-normalized combination of summary scores", ...)` (currently ~line 197-202):

```typescript
    const keys = [
      "complexity", "coupling", "churn", "duplication", "state",
      "clumping", "deadcode", "architecture", "reach", "magic", "guard", "test", "semantic",
    ] as const;
```

2. `test("entropy_score matches the same weighted formula as summary.entropy, per file", ...)` (currently ~line 269-272) — same `keys` array, same edit.

3. `test("JSON schema shape (version 9)", ...)` (currently ~line 226): rename the test title to `"JSON schema shape (version 10)"`, change `expect(result.version).toBe(9)` to `expect(result.version).toBe(10)`, and add `"semantic"` to the summary-keys loop (currently ~line 234-237):

```typescript
    for (const k of [
      "entropy", "complexity", "coupling", "churn", "duplication",
      "state", "clumping", "deadcode", "architecture", "reach", "magic", "guard", "test", "semantic",
      "p95_file_entropy", "critical_hotspots",
    ]) {
```

And add the new per-file numeric facts to the same test's file-key loop (currently ~line 246-260), after `"test_score"`:

```typescript
      "guard_clumps", "max_guard_group", "guard_score", "test_score",
      "max_optional_depth", "nested_optional_occurrences", "semantic_score",
    ]) {
```

(`nested_optional_pub` is a boolean, not a number, so it's checked separately — add right after that loop, near the existing `f.churn_trend`/`f.why` checks:)

```typescript
    expect(typeof f.nested_optional_pub).toBe("boolean");
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/analyze.test.ts`
Expected: FAIL — `FileFacts`/`FileScores` don't have the new properties yet (TypeScript compile error under Bun's type-stripping will surface as `undefined` values failing the assertions, or as a type error if `tsc --noEmit` is run separately).

- [ ] **Step 4: Extend `types.ts`**

In `src/types.ts`, add to `FileFacts` (after `has_test`/`test_path`, currently lines 51-54, before the "Graph-derived" comment on line 55):

```typescript
  // Nested optionality (Option<Option<T>>, deeper): each layer beyond the
  // first hides an additional implicit state a caller must distinguish.
  // Rust struct fields only (see design doc); TypeScript/generic analyzers
  // report 0/false.
  max_optional_depth: number; // worst single field's depth in this file (0 = none nested)
  nested_optional_occurrences: number; // count of nested-Option regex matches across the file
  nested_optional_pub: boolean; // does ANY pub struct in this file have depth >= 1?
```

Add to `FileScores` (after `test_score`, currently line 79, before `why`):

```typescript
  semantic_score: number;
```

Add to `Summary` (after `test`, currently line 109, before `p95_file_entropy`):

```typescript
  semantic: number;
```

Add to `EntropyConfig.entropy` (after `test_weight`, currently line 159):

```typescript
    semantic_weight: number;
```

Add to `EntropyConfig.scoring` (after `test_complexity_cap`, currently line 189):

```typescript
    semantic_depth_cap: number; // max_optional_depth in ONE file scoring 100
    semantic_frequency_cap: number; // nested_optional_occurrences in ONE file scoring 100
```

Add to `DEFAULT_CONFIG.entropy` (after `test_weight: 0.1,`, currently line 206):

```typescript
    semantic_weight: 0.05,
```

Add to `DEFAULT_CONFIG.scoring` (after `test_complexity_cap: 20,`, currently line 229):

```typescript
    semantic_depth_cap: 3,
    semantic_frequency_cap: 8,
```

Update the `AnalysisResult` version comment and value (currently lines 125-129):

```typescript
  // v2: state; v3: clumping; v4: deadcode+architecture+reach; v5: magic;
  // v6: weighted/trending churn, files_skipped, hotspot why-strings;
  // v7: guard (shared-condition) signal; v8: test-coverage-presence signal;
  // v9: entropy_score/priority_score per file, p95_file_entropy/critical_hotspots summary;
  // v10: semantic (nested-optionality) signal
  version: 10;
```

- [ ] **Step 5: Extend `analyze.ts`**

Bump `CACHE_VERSION` (currently line 105):

```typescript
const CACHE_VERSION = "v9"; // v9: semantic (nested-optionality) signal (base.st gains depth/occurrences/pub)
```

Extend `CachedBase.st` shape (currently lines 95-98):

```typescript
  st: {
    types: number; optional: number; boolean: number; max: number;
    clumps: number; maxClump: number; clumpPrefix: string;
    maxOptionalDepth: number; nestedOccurrences: number; nestedPub: boolean;
  };
```

Extend the `base.st` object literal built when the cache misses (currently lines 176-188, inside the `if (contentFresh) {...} else {...}` block in the main loop):

```typescript
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
          maxOptionalDepth: types.reduce((s, t) => Math.max(s, t.max_optional_depth), 0),
          nestedOccurrences: types.reduce((s, t) => s + t.nested_optional_occurrences, 0),
          nestedPub: types.some((t) => t.is_pub && t.max_optional_depth >= 1),
        },
```

Add the three new fields to the `facts.set(path, { ... })` call (currently lines 221-262), after `test_path: tc.test_path,`:

```typescript
      has_test: tc.has_test,
      test_path: tc.test_path,
      max_optional_depth: base.st.maxOptionalDepth,
      nested_optional_occurrences: base.st.nestedOccurrences,
      nested_optional_pub: base.st.nestedPub,
      is_entrypoint: isEntrypoint(path),
```

- [ ] **Step 6: Add the scoring formula**

In the `files: FileMetrics[] = [...facts.values()].map((f) => {...})` block (currently starting line 341), add `semantic_score` right after `test_score` (currently lines 382-384):

```typescript
    const test_score = f.has_test || f.is_entrypoint
      ? 0
      : round1(normalize(f.complexity_total, s.test_complexity_cap));
    // Additive blend, not multiplicative: a post-blend multiplier either
    // vanishes once depth+frequency alone clamp near 100, or over-punishes
    // a single legitimate public PATCH-style field at the low end. See
    // design doc for the worked examples this formula is tuned against.
    const semantic_score = round1(
      Math.min(
        100,
        0.55 * normalize(f.max_optional_depth, s.semantic_depth_cap) +
          0.3 * normalize(f.nested_optional_occurrences, s.semantic_frequency_cap) +
          0.15 * (f.nested_optional_pub ? 100 : 0),
      ),
    );
```

Add `semantic_score` to the `entropyWeightSum` computation (currently lines 331-335):

```typescript
  const entropyWeightSum =
    ew.complexity_weight + ew.coupling_weight + ew.churn_weight +
      ew.duplication_weight + ew.state_weight + ew.clumping_weight +
      ew.deadcode_weight + ew.architecture_weight + ew.reach_weight +
      ew.magic_weight + ew.guard_weight + ew.test_weight + ew.semantic_weight || 1;
```

Add `semantic_score * ew.semantic_weight` to the `fileEntropy` sum (currently lines 391-403):

```typescript
    const fileEntropy =
      (complexity_score * ew.complexity_weight +
        coupling_score * ew.coupling_weight +
        churn_score * ew.churn_weight +
        duplication_score * ew.duplication_weight +
        state_score * ew.state_weight +
        clumping_score * ew.clumping_weight +
        deadcode_score * ew.deadcode_weight +
        architecture_score * ew.architecture_weight +
        reach_score * ew.reach_weight +
        magic_score * ew.magic_weight +
        guard_score * ew.guard_weight +
        test_score * ew.test_weight +
        semantic_score * ew.semantic_weight) / entropyWeightSum;
```

Add `semantic_score` to the returned per-file object (currently lines 406-425), after `test_score,`:

```typescript
      test_score,
      semantic_score,
      hotspot_score,
```

Add `semantic: wmean((f) => f.semantic_score),` to the `summary` object (currently lines 432-451), after `test: wmean((f) => f.test_score),`:

```typescript
        test: wmean((f) => f.test_score),
        semantic: wmean((f) => f.semantic_score),
        entropy: 0,
```

Add `semantic: 0,` to the empty-repo `Summary` fallback literal (currently lines 452-456):

```typescript
    : {
        complexity: 0, coupling: 0, churn: 0, duplication: 0, state: 0,
        clumping: 0, deadcode: 0, architecture: 0, reach: 0, magic: 0,
        guard: 0, test: 0, semantic: 0, entropy: 0, p95_file_entropy: 0, critical_hotspots: 0,
      };
```

Add `summary.semantic * ew.semantic_weight` to the final `summary.entropy` computation (currently lines 457-470):

```typescript
  summary.entropy = round1(
    (summary.complexity * ew.complexity_weight +
      summary.coupling * ew.coupling_weight +
      summary.churn * ew.churn_weight +
      summary.duplication * ew.duplication_weight +
      summary.state * ew.state_weight +
      summary.clumping * ew.clumping_weight +
      summary.deadcode * ew.deadcode_weight +
      summary.architecture * ew.architecture_weight +
      summary.reach * ew.reach_weight +
      summary.magic * ew.magic_weight +
      summary.guard * ew.guard_weight +
      summary.test * ew.test_weight +
      summary.semantic * ew.semantic_weight) / entropyWeightSum,
  );
```

Update the `version: 9,` in the returned `AnalysisResult` object literal (currently line 483) to `version: 10,`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test tests/analyze.test.ts`
Expected: PASS — all existing tests (updated counts/keys/version) plus the new `"semantic signal: ..."` test.

- [ ] **Step 8: Run the full test suite to check for regressions elsewhere**

Run: `bun test`
Expected: `storage.test.ts`, `health.test.ts`, `report.test.ts`, `cli.test.ts` will likely FAIL at this point (they're not touched yet — Tasks 3-5 fix them). Confirm the failures are exactly in those files and are type/field-shape related, not in `analyze.test.ts` or `languages.test.ts`.

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/analyze.ts tests/analyze.test.ts fixtures/rust/nested-optionality/
git commit -m "feat: wire semantic_score (nested optionality) through analyze.ts and the schema"
```

---

### Task 3: `storage.ts` — persist the new fields

**Files:**
- Modify: `src/storage.ts`
- Test: `tests/storage.test.ts`

**Interfaces:**
- Consumes: `FileMetrics.max_optional_depth`, `.nested_optional_occurrences`, `.nested_optional_pub`, `.semantic_score`, `Summary.semantic` from Task 2.

- [ ] **Step 1: Read the existing storage round-trip test for the pattern to follow**

Run: `grep -n "saveSnapshot\|guard_score\|test_score" tests/storage.test.ts`

Find the existing test that calls `storage.saveSnapshot(result)` and reads back `file_metrics` rows — follow its exact structure for the new assertion (this repo's convention is to query the raw SQLite row via `db.query(...).all()` and check specific columns exist and hold the expected value).

- [ ] **Step 2: Write the failing test**

Add to `tests/storage.test.ts`, in the same `describe` block as the existing `saveSnapshot` round-trip tests:

```typescript
  test("semantic signal columns survive a save/reload round-trip", () => {
    const db = new Storage(TEST_DB);
    const id = db.saveSnapshot(result);
    const row = db.db
      .query("SELECT max_optional_depth, nested_optional_occurrences, nested_optional_pub, semantic_score FROM file_metrics WHERE snapshot_id = ? AND path = ?")
      .get(id, "rust/nested-optionality/src/lib.rs") as {
        max_optional_depth: number; nested_optional_occurrences: number;
        nested_optional_pub: number; semantic_score: number;
      };
    expect(row.max_optional_depth).toBe(2);
    expect(row.nested_optional_occurrences).toBe(2);
    expect(row.nested_optional_pub).toBe(1); // SQLite stores booleans as 0/1
    expect(row.semantic_score).toBeGreaterThan(0);
    db.close();
  });
```

Check the top of `tests/storage.test.ts` for how `TEST_DB` and `result` (an `AnalysisResult` fixture) are already set up in that file — reuse the existing constants/setup rather than redefining them. If the file doesn't already have an `AnalysisResult` built from `analyzeRepo(FIXTURES, ...)`, add:

```typescript
import { analyzeRepo } from "../src/analyze";
import { DEFAULT_CONFIG } from "../src/types";
const FIXTURES = join(import.meta.dir, "..", "fixtures");
const result = analyzeRepo(FIXTURES, DEFAULT_CONFIG, DEFAULT_CONFIG.analysis.since, null, null);
```

(adjust imports/paths to match whatever this file already imports — check before adding duplicates.)

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/storage.test.ts -t "semantic signal columns"`
Expected: FAIL — column `max_optional_depth` doesn't exist in `file_metrics` yet (SQLite error) or `saveSnapshot`'s positional `VALUES` list is misaligned.

- [ ] **Step 4: Add the schema migration**

In `src/storage.ts`, add four columns to `file_metrics`'s `CREATE TABLE IF NOT EXISTS` (currently lines 39-51) is NOT the right place for existing DBs — follow this codebase's established pattern of additive `ALTER TABLE` migrations. Add to the fresh-create SQL too (so a brand-new DB has the columns from the start), appending to the column list in the `CREATE TABLE IF NOT EXISTS file_metrics` block (currently line 50, right before the closing `)`):

```sql
        complexity_score REAL, coupling_score REAL, churn_score REAL,
        duplication_score REAL, hotspot_score REAL, entropy_contribution REAL,
        max_optional_depth INTEGER, nested_optional_occurrences INTEGER,
        nested_optional_pub INTEGER, semantic_score REAL
```

Also add `semantic` to the `snapshots` `CREATE TABLE` — this table doesn't have a per-signal column list to append to inline (columns like `guard`/`test` were only ever added via the migration list, never backfilled into the original `CREATE TABLE`), so leave `CREATE TABLE snapshots` untouched and rely on the migration list below, matching how `guard`/`test` were done.

Add to the migration array (currently lines 64-101), at the end, following the exact style of the `guard`/`test` block immediately above:

```typescript
      "ALTER TABLE snapshots ADD COLUMN semantic REAL NOT NULL DEFAULT 0",
      "ALTER TABLE file_metrics ADD COLUMN max_optional_depth INTEGER",
      "ALTER TABLE file_metrics ADD COLUMN nested_optional_occurrences INTEGER",
      "ALTER TABLE file_metrics ADD COLUMN nested_optional_pub INTEGER",
      "ALTER TABLE file_metrics ADD COLUMN semantic_score REAL",
```

(The migration list runs unconditionally and swallows "duplicate column name" errors, so appending here is safe even though the fresh-create SQL above already defines these `file_metrics` columns for new databases — existing DBs created before this change pick them up via the `ALTER TABLE` path instead.)

- [ ] **Step 5: Update `saveSnapshot`'s INSERT statements**

In the `snapshots` insert (currently lines 162-168), add `semantic` to the column list and one more `?` placeholder:

```typescript
    const insert = this.db.query(`
      INSERT INTO snapshots (repository, commit_hash, timestamp, entropy,
        complexity, coupling, churn, duplication, state, clumping, deadcode,
        architecture, reach, magic, guard, test, semantic, files_analyzed, report_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `);
```

Add `s.semantic` to the `insert.get(...)` call (currently lines 177-182), right after `s.guard, s.test,`:

```typescript
    const row = insert.get(
      result.repository.name, result.repository.commit, result.timestamp,
      s.entropy, s.complexity, s.coupling, s.churn, s.duplication, s.state,
      s.clumping, s.deadcode, s.architecture, s.reach, s.magic, s.guard, s.test,
      s.semantic, result.files_analyzed, JSON.stringify(slim),
    ) as { id: number };
```

In the `file_metrics` insert (currently lines 186-200), add the four new column names to the column list and four more `?` placeholders:

```typescript
    const fm = this.db.query(`
      INSERT INTO file_metrics (snapshot_id, path, language, loc,
        complexity_total, complexity_average, complexity_max, fan_in, fan_out,
        dependency_count, dependent_count, commits, lines_added, lines_deleted,
        duplicated_lines, duplicated_blocks, duplication_percentage,
        complexity_score, coupling_score, churn_score, duplication_score,
        hotspot_score, entropy_contribution, type_count, optional_fields,
        boolean_fields, max_state_fields, state_score, data_clumps,
        max_clump_fields, clump_prefix, clumping_score, is_orphan,
        transitive_dependents, arch_violations, deadcode_score,
        architecture_score, reach_score, magic_numbers, magic_strings,
        magic_score, weighted_commits, churn_trend, why, guard_clumps,
        max_guard_group, guard_prefix, guard_score, has_test, test_path, test_score,
        max_optional_depth, nested_optional_occurrences, nested_optional_pub, semantic_score)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
```

(Count check: 51 placeholders before this change, per the design doc's storage.ts warning — verify the new count is 55 by counting the column list: the original had 51 columns, this adds 4 more = 55. Count the `?` characters after editing to confirm they match exactly.)

Add the four new values to the `fm.run(...)` call inside the transaction (currently lines 203-219), after `f.has_test ? 1 : 0, f.test_path, f.test_score,`:

```typescript
          f.has_test ? 1 : 0, f.test_path, f.test_score,
          f.max_optional_depth, f.nested_optional_occurrences,
          f.nested_optional_pub ? 1 : 0, f.semantic_score,
        );
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/storage.test.ts`
Expected: PASS — new test plus every pre-existing `storage.test.ts` test (the column/placeholder counts must line up exactly or every `saveSnapshot` call will throw "table file_metrics has N columns but M values were supplied").

- [ ] **Step 7: Commit**

```bash
git add src/storage.ts tests/storage.test.ts
git commit -m "feat: persist semantic signal columns in snapshots/file_metrics"
```

---

### Task 4: `health.ts` — attention list + labels

**Files:**
- Modify: `src/health.ts`
- Test: `tests/health.test.ts`

**Interfaces:**
- Consumes: `Summary.semantic` from Task 2.

- [ ] **Step 1: Write the failing test**

In `tests/health.test.ts`, update `ZERO_SUMMARY` (currently lines 92-96) to include the new field (required by the `Summary` type now):

```typescript
const ZERO_SUMMARY = {
  entropy: 0, complexity: 0, coupling: 0, churn: 0, duplication: 0, state: 0,
  clumping: 0, deadcode: 0, architecture: 0, reach: 0, magic: 0, guard: 0, test: 0,
  semantic: 0, p95_file_entropy: 0, critical_hotspots: 0,
};
```

Update the test title and body at `test("lists only the 12 summary signals scoring >= 30, sorted descending", ...)` (currently lines 99-105) to reflect 13 signals and add semantic to the coverage:

```typescript
  test("lists only the 13 summary signals scoring >= 30, sorted descending", () => {
    const h = computeHealth(
      withOverrides({ summary: { ...ZERO_SUMMARY, churn: 45, reach: 60, semantic: 35, state: 10, complexity: 5 } }),
    );
    const labels = h.attention.map((a) => a.label);
    expect(labels).toEqual(["Reach", "Churn", "Semantic"]); // sorted desc, state/complexity excluded (<30)
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/health.test.ts -t "lists only the 13 summary signals"`
Expected: FAIL — `"Semantic"` never appears in `h.attention` because `signalKeys`/`SIGNAL_LABELS` don't include `semantic` yet, and `ZERO_SUMMARY`/`Summary` type mismatch may also surface as a compile-time issue.

- [ ] **Step 3: Update `health.ts`**

Add to `SIGNAL_LABELS` (currently lines 40-44):

```typescript
const SIGNAL_LABELS: Record<string, string> = {
  complexity: "Complexity", coupling: "Coupling", churn: "Churn", duplication: "Duplication",
  state: "State", clumping: "Clumping", deadcode: "Dead code", architecture: "Architecture",
  reach: "Reach", magic: "Magic", guard: "Guard", test: "Test", semantic: "Semantic",
};
```

Add `"semantic"` to `signalKeys` (currently lines 76-79):

```typescript
  const signalKeys = [
    "complexity", "coupling", "churn", "duplication", "state", "clumping",
    "deadcode", "architecture", "reach", "magic", "guard", "test", "semantic",
  ] as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/health.test.ts`
Expected: PASS — all existing tests plus the updated 13-signal test.

- [ ] **Step 5: Commit**

```bash
git add src/health.ts tests/health.test.ts
git commit -m "feat: surface semantic signal in repository health attention list"
```

---

### Task 5: `report.ts` — render the new signal

**Files:**
- Modify: `src/report.ts`
- Test: `tests/report.test.ts`

**Interfaces:**
- Consumes: `FileMetrics.max_optional_depth`, `.nested_optional_occurrences`, `.nested_optional_pub`, `.semantic_score`, `Summary.semantic` from Task 2.

- [ ] **Step 1: Write the failing test**

Check `tests/report.test.ts`'s existing `describe("renderFile", ...)` block (currently around line 129) for the fixture-file object it builds/uses, then add:

```typescript
  test("renderFile shows the Semantic ambiguity section when nested optionality is present", () => {
    const nested = result.files.find((f) => f.path === "rust/nested-optionality/src/lib.rs")!;
    const text = renderFile(nested);
    expect(text).toContain("Semantic ambiguity");
    expect(text).toMatch(/worst depth: 2/);
  });
```

(If `result`/`analyzeRepo` isn't already imported/computed at the top of `tests/report.test.ts`, check how the existing `renderFile` tests obtain their `FileMetrics` object — reuse that exact setup rather than introducing a second one.)

Also add a summary-line assertion near any existing `renderAnalysis`/`renderMarkdown` tests in the same file:

```typescript
  test("renderAnalysis includes the Semantic summary line", () => {
    const text = renderAnalysis(result);
    expect(text).toContain("Semantic:");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/report.test.ts -t "Semantic"`
Expected: FAIL — neither string appears in the rendered output yet.

- [ ] **Step 3: Update `renderFile`**

In `src/report.ts`, add a new section to `renderFile` (currently lines 153-215), directly after the "Test coverage" section (currently lines 206-207) and before "Graph":

```typescript
Test coverage
  ${f.has_test ? `covered (${f.test_path})` : "NO TEST FOUND"}

Semantic ambiguity
  nested Option occurrences: ${f.nested_optional_occurrences}${
    f.max_optional_depth > 0
      ? `\n  worst depth: ${f.max_optional_depth} (${f.max_optional_depth + 2} implicit states)${
          f.nested_optional_pub ? " — appears in a public struct" : ""
        }`
      : ""
  }

Graph
```

(This replaces the existing `Test coverage\n  ${...}\n\nGraph` fragment — insert the new block between them, keeping everything else in the template unchanged.)

- [ ] **Step 4: Update `renderAnalysis` and `renderMarkdown`**

In `renderAnalysis` (currently lines 25-63), add a `Semantic:` line after `Test:` (currently line 50):

```typescript
Test:         ${fmt(r.summary.test)}
Semantic:     ${fmt(r.summary.semantic)}

Entropy Index: ${severity(r.summary.entropy)(fmt(r.summary.entropy))}
```

In `renderMarkdown`'s summary table (currently lines 274-293), add a row after `| Test | ... |` (currently line 292):

```markdown
| Test | ${fmt(r.summary.test)} |
| Semantic | ${fmt(r.summary.semantic)} |
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/report.test.ts`
Expected: PASS — all existing tests plus the two new ones.

- [ ] **Step 6: Commit**

```bash
git add src/report.ts tests/report.test.ts
git commit -m "feat: render semantic ambiguity signal in text/markdown reports"
```

---

### Task 6: README documentation

**Files:**
- Modify: `README.md`

**Interfaces:** None (docs only).

- [ ] **Step 1: Update the scores table**

In `README.md`'s "How scores are derived" table (currently lines 68-82), add a row after the `test` row (currently line 81), before the `entropy index` row:

```markdown
| semantic | `0.55·norm(max_optional_depth, 3) + 0.30·norm(nested_optional_occurrences, 8) + 0.15·(any pub struct nested? 100 : 0)` — Rust `Option<Option<T>>` (and deeper) struct fields. Not automatically bad: a `pub struct UpdateUser { name: Option<Option<String>> }` can be a legitimate PATCH tri-state (`None`=don't touch, `Some(None)`=clear, `Some(Some(v))`=set) — the signal surfaces where nesting concentrates (deep, frequent, public) rather than flagging any single occurrence as wrong. Explicit state enums (`enum FieldUpdate<T> { Unchanged, Clear, Set(T) }`) are exempt — only `struct` bodies are scanned |
```

Update the entropy-index row's weight list (currently line 82) to include the new default:

```markdown
| entropy index | weighted mean of the thirteen scores, normalized by the weight sum (defaults: complexity .20, coupling .20, churn .15, duplication .10, state .10, clumping .10, deadcode .05, architecture .05, reach .05, magic .05, guard .05, test .10, semantic .05 — `[entropy]`) |
```

- [ ] **Step 2: Update the health section signal count**

Currently line 135:

```markdown
**Attention list** — any of the 13 summary signals (complexity…semantic) ≥ 30,
sorted descending. **Structural list** — `cycles`/`architecture_violations`
counts: HEALTHY at 0, ATTENTION when present (a single cycle is already
worth knowing about, not graded).
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document the semantic (nested-optionality) signal"
```

---

### Task 7: Validate against ez-stock's Rust backend

**Files:** None modified — this is a manual verification pass against a real external codebase, per the design doc's Validation section.

**Interfaces:** None (uses the CLI built in prior tasks).

- [ ] **Step 1: Initialize entropy-hunter config for ez-stock's backend (if not already present)**

Run: `bun /home/ariel/Projects/Personal/entropy-hunter/src/cli.ts init --repo /home/ariel/Projects/Personal/ez-stock/backend`

- [ ] **Step 2: Run the analysis and capture the JSON report**

Run: `bun /home/ariel/Projects/Personal/entropy-hunter/src/cli.ts report --repo /home/ariel/Projects/Personal/ez-stock/backend --format json > /tmp/ez-stock-entropy-report.json`

- [ ] **Step 3: Confirm the signal fires on the files already confirmed to contain nested Options**

Run: `bun -e 'const r = require("/tmp/ez-stock-entropy-report.json"); for (const f of r.files) if (f.max_optional_depth > 0) console.log(f.path, f.max_optional_depth, f.nested_optional_occurrences, f.nested_optional_pub, f.semantic_score);'`

Expected: at least `shared/patch.rs` and `contexts/purchases/domain.rs` (confirmed during design to contain `Option<Option<...>>`) appear in the output with `max_optional_depth >= 1`.

- [ ] **Step 4: Spot-check for false positives**

Run: `grep -rn "Option<Option<" /home/ariel/Projects/Personal/ez-stock/backend/src --include="*.rs" | wc -l`

Compare this count against the sum of `nested_optional_occurrences` across all files in the JSON report (`bun -e 'const r = require("/tmp/ez-stock-entropy-report.json"); console.log(r.files.reduce((s,f)=>s+f.nested_optional_occurrences,0));'`). They won't match exactly (grep counts lines, the analyzer counts stripped-source regex matches, and tuple structs/comments differ), but a wildly divergent number (e.g. 3x higher or a large fraction near 0 when grep found dozens) signals a detection bug worth investigating before calling this done.

- [ ] **Step 5: Report findings to the user**

Summarize: how many files scored `semantic_score > 0`, the highest-scoring file and why (depth/frequency/pub), and whether the grep spot-check count is in the same ballpark as the detector's count. This is a manual step — there is no commit for it, since no repo files change.

---

## Final check across all tasks

- [ ] Run `bun test` from `/home/ariel/Projects/Personal/entropy-hunter` — full suite green.
- [ ] Run `bun src/cli.ts analyze --repo .` from `/home/ariel/Projects/Personal/entropy-hunter` (dogfooding: analyze entropy-hunter's own source) and confirm the `Semantic:` line appears in the output with no crash.
