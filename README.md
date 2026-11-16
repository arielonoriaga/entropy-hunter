# entropy-hunter

Deterministic CLI that measures how a codebase changes and surfaces early signs
of increasing software entropy. Supports **Rust** and **TypeScript/JavaScript**.
Runs entirely locally (Bun + SQLite; one small runtime dependency, `picocolors`,
for terminal color).

> **The Entropy Index is an engineering heuristic, not a universal
> measurement.** Every score is deterministically derived from raw facts
> (imports, decision points, git numstat, duplicated blocks) via documented,
> configurable normalization. Interpretation is left to humans — or a future
> AI agent consuming the JSON output.

## Install

```bash
cd entropy-hunter && bun install && bun link   # puts `entropy` on PATH (~/.bun/bin)
```

`bun link` symlinks this repo's `src/cli.ts` as the global `entropy` binary
(via `bin.entropy` in `package.json`), so it stays in sync with `git pull` —
no rebuild/reinstall step. Make sure `~/.bun/bin` is on `PATH` (bun's
installer adds this to your shell profile automatically). Verify with
`entropy --help` from any directory. To remove: `bun unlink` from this repo,
or `rm ~/.bun/bin/entropy`.

## Usage

```bash
cd my-project
entropy init                                   # creates .entropy/config.toml
entropy analyze                                # working-tree analysis
entropy snapshot                               # persist snapshot for current commit
entropy hotspots --limit 20 [--language rust]
entropy priority --limit 20 [--language rust]  # entropy x reach — dangerous, not just messy
entropy health                                 # executive summary: bands + recommendations
entropy history [--limit 20] [--since 90d]
entropy file src/orders/service.rs
entropy zoom [path]                            # zoom out: modules, or file → module → repo
entropy check [--base <ref>]                   # gate: did the changed files get worse? exit 1 if so
entropy report --format json|markdown|text
```

Analysis is incremental everywhere, initialized or not. Per-file results are
cached by content hash, and the churn log is extended commit by commit instead
of re-walked, so a repeat run only re-processes what changed (~0.45s warm vs
~2s cold on a 3k-file, 36 MB repo; a new commit costs one `git log old..new`,
not the whole window). The cache lives outside the project — one database per
repository under `$XDG_CACHE_HOME/entropy-hunter/` (`~/.cache/…`), shared by
all of its worktrees, so a fresh worktree starts warm and nothing is written
into the repo. `ENTROPY_CACHE_DIR` moves it; `ENTROPY_NO_CACHE=1` disables it.
`.entropy/entropy.db` holds only what is the project's own: snapshots and
history (created by the first `entropy snapshot`).

All commands accept `--repo <path>` to analyze a repository other than the cwd,
and `--since 30d|12w|6m` to override the churn window.

## Data model — three layers

1. **Raw facts** (deterministic measurements): `complexity_total`, `fan_in`,
   `fan_out`, `commits`, `lines_added`, `duplicated_lines`, …
2. **Derived scores** (deterministic normalization to 0–100):
   `complexity_score`, `coupling_score`, `churn_score`, `duplication_score`,
   `hotspot_score`, `entropy_index`.
3. **Interpretation** — intentionally absent. Belongs to a future agent.

**One deliberate exception:** `entropy health` runs a small, fixed,
auditable rule table over already-computed scores — not free-form judgment.
See [Repository Health](#repository-health) below for the exact rules.

### How scores are derived

Normalization is linear and clamped: `score = min(100, 100 * raw / cap)`.
Caps live in `.entropy/config.toml` under `[scoring]` and are honest defaults,
not constants of nature:

| Score | Formula |
|---|---|
| complexity | `0.5·norm(avg_complexity, 10) + 0.5·norm(max_complexity, 30)` |
| coupling | `norm(fan_in + fan_out, 20)` |
| churn | `0.5·norm(commits, 10) + 0.5·norm(lines_changed / loc, 1.0)` — normalized per line so big files aren't penalized for size |
| duplication | duplicated-line percentage (windowed 6-line clone detection over normalized lines; punctuation-only lines — lone brackets, blanked string literals — are not fingerprinted, so two string tables don't "clone" each other). `duplicate_partners` names the files sharing the most windows |
| state | `norm(worst_type_state_fields, 6)` — optional + boolean fields of the worst single type. Each such field ~doubles the representable states ("make illegal states unrepresentable"); sum types / discriminated unions score 0 |
| clumping | `norm(worst_clump_fields, 6)` — largest group of 3+ fields sharing a name prefix in one type (`order_id`, `order_date`, `order_total` → a flattened Order entity; extract it and reference the existing identity). Boolean prefixes (`is_`, `has_`) excluded — that's the state signal's job |
| deadcode | 100 if the file is an orphan (fan-in 0 and not an entrypoint/test/config), else 0. LOC-weighted summary = % of code nothing imports |
| architecture | `norm(inner→outer imports, 3)` — `[architecture] layers` lists layer names inner→outer (default `domain, application, infrastructure, api`), matched against path segments; a domain file importing infrastructure is a violation (hexagonal direction). Unlayered paths are exempt |
| reach | `norm(transitive dependents as % of repo, 25)` — how much of the codebase can break when this file changes |
| magic | `norm(magic literals per 100 LOC, 5)` — unnamed numbers in logic (0/1/2 exempt, named-constant declarations exempt), string literals in comparisons and case/match arms (stringly-typed logic wanting to be an enum), plus repeated visible JSX text (copy that should live in a dictionary). A chain of 3+ comparisons against the SAME identifier (`x !== "a" && x !== "b" && x !== "c"`) counts an extra point per chain on top of each comparison already counted — that specific shape collapses into one `Set.has(x)`/`!SET.has(x)`, which scattered comparisons against unrelated identifiers don't. Density-based so big files earn no extra budget |
| guard | `norm(worst shared-guard group, 4)` — sibling `if`s at the same indent sharing a leading `&&` conjunct (`if (isLoggedIn() && a())` next to `if (isLoggedIn() && b())`): the guard is re-checked N times instead of once with nested/early-return branches inside ("Consolidate Conditional Expression") |
| test | 0 if tested (or an entrypoint, or has no functions to protect), else `norm(complexity_total, 20)` — untested complexity is worse than untested trivia. Presence, not quality: Rust's inline `#[cfg(test)]`, TS/Go/Python companion-file conventions, or a transitive fallback (does ANY file that eventually imports this one turn out to be a test?) |
| semantic | `0.55·norm(max_optional_depth, 3) + 0.30·norm(nested_optional_occurrences, 8) + 0.15·(any pub struct nested? 100 : 0)` — Rust `Option<Option<T>>` (and deeper) struct fields. Not automatically bad: a `pub struct UpdateUser { name: Option<Option<String>> }` can be a legitimate PATCH tri-state (`None`=don't touch, `Some(None)`=clear, `Some(Some(v))`=set) — the signal surfaces where nesting concentrates (deep, frequent, public) rather than flagging any single occurrence as wrong. Explicit state enums (`enum FieldUpdate<T> { Unchanged, Clear, Set(T) }`) are exempt — only `struct` bodies are scanned |
| entropy index | weighted mean of the thirteen scores, normalized by the weight sum (defaults: complexity .20, coupling .20, churn .15, duplication .10, state .10, clumping .10, deadcode .05, architecture .05, reach .05, magic .05, guard .05, test .10, semantic .05 — `[entropy]`) |

Churn itself is recency-weighted (90-day exponential half-life, so a file
quiet for a year doesn't outrank one actively churning this week) and
carries a per-file `churn_trend` (`accelerating`/`stable`/`cooling`, recent-
half vs older-half commit frequency). Merge commits are excluded
(`--no-merges`) and author identities are unified (`--use-mailmap`) so churn
counts authored changes, not merge noise or split committer identities.
The window starts at UTC midnight of its first day and weights are taken
relative to the start of the current UTC day, so the same commit scores the
same no matter what time of day the analysis runs.

Every hotspot carries a `why` string naming its dominant raw fact (e.g.
*"driven by churn (14 commits, 9.2 weighted, accelerating)"*) — traceable
without cross-referencing the scoring config.

**Configuration is validated, not silently ignored.** `entropy init`/every
command that loads `config.toml` rejects unknown sections/keys, type
mismatches, non-positive scoring caps, negative or all-zero weights, and
malformed `[analysis] since`/`[architecture] layers`, with the offending key
named in the error and exit code 2 — a typo like `[scorring]` or a `cap = 0`
used to silently produce wrong scores with no signal that anything was off.
| hotspot | weighted mean of complexity/coupling/churn (defaults .35/.35/.30 — `[hotspots]`) |

Global summary scores are LOC-weighted means of per-file scores, so each
file's `entropy_contribution` sums to the global index.

**Priority — entropy × reach.** `entropy_score` is the same weighted-mean
formula as the global Entropy Index, but computed per file and *not*
LOC-weighted — how bad a file is in isolation, so a small nasty file scores
as badly as a big one. `priority_score = entropy_score * (transitive
dependents ÷ files analyzed)` — a high-entropy file nobody depends on is low
risk; a moderately messy file most of the codebase transitively imports is
dangerous. `entropy priority` ranks files by `priority_score`. The summary
carries two derived numbers alongside `entropy` (the LOC-weighted global
index): `p95_file_entropy` (95th percentile of per-file `entropy_score` —
"how bad are the worst files") and `critical_hotspots` (count of files with
`priority_score` ≥ `[priority] critical_threshold`, default 20).

### Repository Health

`entropy health` (also folded into `analyze`/`report` text output) is an
executive-summary view: four topline bands, an Attention list, a Structural
list, and a Recommendation. The bands/lists are threshold classification —
the same spirit as the existing 🔴🟠🟡🟢 severity dots. The Recommendation is
the **one deliberate exception** to "interpretation is out of scope": a
fixed, auditable rule table, not free-form judgment.

**Topline bands:**

| Metric | HEALTHY | ATTENTION | CRITICAL |
|---|---|---|---|
| Entropy / P95 File Entropy | < 30 | 30–69 | ≥ 70 |
| Critical Hotspots | 0 (NONE) | 1–4 (SOME) | ≥ 5 (HIGH) |
| Trend | STABLE or FALLING | — | RISING (delta > 0.5) |

**Attention list** — any of the 13 summary signals (complexity…semantic) ≥ 30,
sorted descending. **Structural list** — `cycles`/`architecture_violations`
counts: HEALTHY at 0, ATTENTION when present (a single cycle is already
worth knowing about, not graded).

**Recommendation rule table** — each rule is a condition over `summary`/
`cycles`; if none fire, `entropy health` says "No broad refactoring
recommended":

| Condition | Recommendation |
|---|---|
| `summary.churn ≥ 30` | High-churn modules |
| `summary.reach ≥ 30 AND summary.churn ≥ 30` | High-reach, high-churn modules |
| `cycles.length > 0` | Circular dependencies |
| `summary.state ≥ 30` | State-heavy domain types |

Complexity is a cyclomatic proxy: decision tokens (`if`/`for`/`while`/`case`/
`catch`/`&&`/`||`/`??` for TS; `if`/`while`/`loop`/`for`/`&&`/`||`/match-arm
`=>` for Rust) counted per function via regex heuristics — deterministic and
explainable, not AST-exact.

### Check — did this change make it worse?

`entropy check` is the gate. It measures the working tree and the tree at a
base commit with the same engine and the same churn data, and compares every
changed file with its own earlier self. Like `health`, it is a fixed,
auditable rule table over raw facts — so each finding names something
concrete (a function, a clone partner, an import), not just a number.

```bash
entropy check                         # base: auto
entropy check --base origin/main --format json
entropy check --touched-since 2026-11-16T09:00:00Z    # only files modified since then
entropy check --accept src/tax/table.ts --reason "generated lookup table"
```

`--base auto` (the default) is the fork point from the upstream branch, else
from the default branch (`origin/HEAD`, `origin/main`, `main`, …), else `HEAD`
— i.e. everything this work adds on top of what is already shared, committed
or not. Renamed files are compared with their old path. Only files that
changed are judged; the base tree is read straight from git (one batched
call for the changed files), so a check costs about two warm runs.

| Rule | Level | Fires when, for a changed file |
|---|---|---|
| `complexity` | fail | a function is above `function_complexity` (15) **and** higher than it was. A function that appears while an at-least-as-complex one shrinks or disappears is a rename/extraction, not new complexity |
| `duplication` | fail | duplicated lines rose by ≥ `new_duplicated_lines` (6) — names the partner files |
| `cycle` | fail | the file is on a dependency cycle and was not before |
| `architecture` | fail | inner→outer layer imports rose |
| `entropy` | fail | `entropy_score` rose by ≥ `max_file_delta` (5), or a brand-new file starts at ≥ `new_file_entropy` (30) |
| `untested` | warn | complexity ≥ `test_complexity_cap` with no test, and that is new |
| `orphan` | warn | a new file nothing imports |
| *signal* | warn | a state/clumping/magic/guard/semantic score rose ≥ 10 into the attention band — with the raw fact |

Exit code: 0 pass (warnings allowed), 1 fail, 2 error. Thresholds live in
`[gate]`. A regression that is the right call can be accepted with a recorded
reason (`--accept` + `--reason`); the acceptance is bound to the file's exact
content, so any later edit is judged again.

### Zoom — at which level does the cause live?

A hotspot list says which file is worst; it cannot say whether that file is
the problem or only where a larger problem surfaces. `entropy zoom` rolls the
same measurements up the directory tree.

`entropy zoom` (no path) ranks directories by their share of the repository's
entropy mass (`loc × entropy_score`), with each one's dominant signals, its
*cohesion* (fraction of its dependency edges that stay inside it) and its
worst files.

`entropy zoom <file|dir>` prints the ladder — file → each enclosing module →
repository — with a *lens* at every level, and names the outermost level that
owns a cause (`fix_at`). The lens is the third fixed rule table:

| Lens | Fires when |
|---|---|
| `local` | the file's entropy is ≥ 10 above its module's mean, or one of its signals is critical (≥ 70) while the module's is < 30 |
| `pattern` | ≥ half of a level's files (min 3) are hot (≥ 30) on the same signal — counted only *outside* the level you climbed from, so a parent doesn't inherit its child's pattern |
| `boundary` | cohesion < 0.3 with ≥ 5 edges crossing |
| `shared-home` | ≥ 2 files duplicate code living outside the module |
| `concentrated` | one file holds ≥ half of an attention-band module's entropy mass |
| `healthy` | none of the above, below the attention band |

## Architecture

```
src/
  cli.ts              flag + command tables (no framework)
  analyze.ts          the engine: measure → link graph → score → summarize
  tree.ts             SourceTree: the working tree, or the tree at a commit
  check.ts            the gate: per-file rule table, waivers
  zoom.ts             module rollups, the zoom ladder and its lens
  graph.ts            transitive reach as bitsets over strongly connected components
  aliases.ts          tsconfig/jsconfig `paths` + `baseUrl` resolution
  cache.ts            where the incremental cache lives
  languages/
    analyzer.ts       LanguageAnalyzer interface + shared helpers
    strip.ts          comment/string/regex-literal blanking (every other pass builds on it)
    rust.ts           mod/use resolution, fn complexity
    typescript.ts     import/export resolution, function complexity
    generic.ts        regex-approximate fallback for everything else
  git.ts              incremental churn log, base resolution, reading a commit's files
  duplication.ts      isolated windowed clone detector (swappable)
  storage.ts          SQLite: snapshots, and the cache tables
  report.ts           text / markdown rendering
  config.ts, toml.ts  config load/init
```

The engine reads files only through a `SourceTree`, so the same code scores
the working tree and any past commit — that is what `check` is built on.

Adding a language = implement `LanguageAnalyzer` (detect / complexity /
imports + resolve / normalizedLines / stateSpace) and register it in
`languages/index.ts`. Dependencies are split in two on purpose: `imports()`
reads only the file (cached per content), `resolve()` maps those specifiers
onto the current file set (cheap, redone every run) — so adding or deleting a
file never invalidates anyone else's cache entry. The engine never sees
language-specific structures.

**Path aliases.** TypeScript/JavaScript imports are resolved through the
nearest `tsconfig*.json` / `jsconfig.json` (`compilerOptions.paths`,
`baseUrl`, relative `extends`). Without this, every `~/x` or `@/x` import
looks like a package and an aliased codebase has almost no dependency graph.

**Language-agnostic by default**: files not covered by a dedicated plugin
fall back to a generic analyzer (`languages/generic.ts`) covering Python,
Go, Java, Ruby, PHP, C/C++, C#, Kotlin, Swift, Scala, Dart, Lua, Elixir,
shell, Zig, GDScript. For those, churn / duplication / LOC / dead-code / reach are
exact; complexity and dependencies are regex-approximate; state/clumping
are skipped. A dedicated plugin upgrades a language from approximate to
precise without touching the engine.

The JSON report (`report --format json`, `"version": 12`) plus the SQLite
schema (`snapshots`, `file_metrics`) carry everything a future agent needs
for `get_repository_summary`, `get_file_metrics`, `get_hotspots`,
`get_history`, `get_dependencies` (per-file internal deps are recomputed on
demand by `entropy file`).

## AI / agent usage

The CLI is agent-friendly by design:

- **Clean machine output** — progress feedback only renders on a TTY
  (stderr); piped/agent runs get pure JSON on stdout.
- **JSON everywhere** — `report --format json` (full graph incl. per-file
  `dependencies`/`dependents`), `hotspots --format json`,
  `priority --format json`, `health --format json`, `file <path> --format
  json` (adds per-function complexity), `zoom --format json`,
  `check --format json`. Output is written synchronously, so a large report
  piped into `jq` arrives whole.
- **A gate, not a suggestion** — `entropy check` exits 1 when changed files
  regressed, which is what a pre-push hook, a CI step or an agent harness can
  key on. For Claude Code, a `Stop` hook running
  `entropy check --touched-since <session start> --format json` and blocking
  on `verdict: "fail"` makes the measurement happen every turn without anyone
  remembering to ask for it.
- **Claude Code skill** — `skills/reduce-entropy/SKILL.md` implements a
  measure → zoom out → refactor → re-measure loop. Install into a project:

  ```bash
  mkdir -p .claude/skills && cp -r /path/to/entropy-hunter/skills/reduce-entropy .claude/skills/
  ```

  then ask Claude Code to "reduce entropy". The skill enforces: find the
  level that owns the cause before editing (`entropy zoom`), one target per
  commit, tests green at every step, no score-gaming.

## Known MVP limits

- Complexity/function detection is regex-heuristic (no ternary counting in TS;
  inline callbacks attribute to the enclosing function).
- Path aliases come from `tsconfig`/`jsconfig` only — bundler-only aliases
  (`vite.config` `resolve.alias`) and package `exports` maps still count as
  external imports.
- JS regex literals are recognized by what precedes the `/`; a division
  directly after `}` or a regex in JSX text can be misread (confined to one line).
- `check`'s rename/extraction allowance is per file: complexity moved in
  from another file reads as new.
- Duplication is a 6-line normalized-window detector — isolated in
  `duplication.ts` for later replacement.

## Tests

```bash
bun test   # complexity, deps, aliases, coupling, churn (incl. incremental),
           # duplication, reach, normalization, entropy, hotspots, priority,
           # health, check, zoom, persistence, history, JSON schema, CLI
```
