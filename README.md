# entropy-hunter

Deterministic CLI that measures how a codebase changes and surfaces early signs
of increasing software entropy. Supports **Rust** and **TypeScript/JavaScript**.
Runs entirely locally (Bun + SQLite, zero runtime dependencies).

> **The Entropy Index is an engineering heuristic, not a universal
> measurement.** Every score is deterministically derived from raw facts
> (imports, decision points, git numstat, duplicated blocks) via documented,
> configurable normalization. Interpretation is left to humans — or a future
> AI agent consuming the JSON output.

## Usage

```bash
cd my-project
bun /path/to/entropy-hunter/src/cli.ts init      # creates .entropy/{config.toml,entropy.db}
... analyze                                       # working-tree analysis
... snapshot                                      # persist snapshot for current commit
... hotspots --limit 20 [--language rust]
... history [--limit 20] [--since 90d]
... file src/orders/service.rs
... report --format json|markdown|text
```

All commands accept `--repo <path>` to analyze a repository other than the cwd,
and `--since 30d|12w|6m` to override the churn window.

## Data model — three layers

1. **Raw facts** (deterministic measurements): `complexity_total`, `fan_in`,
   `fan_out`, `commits`, `lines_added`, `duplicated_lines`, …
2. **Derived scores** (deterministic normalization to 0–100):
   `complexity_score`, `coupling_score`, `churn_score`, `duplication_score`,
   `hotspot_score`, `entropy_index`.
3. **Interpretation** — intentionally absent. Belongs to a future agent.

### How scores are derived

Normalization is linear and clamped: `score = min(100, 100 * raw / cap)`.
Caps live in `.entropy/config.toml` under `[scoring]` and are honest defaults,
not constants of nature:

| Score | Formula |
|---|---|
| complexity | `0.5·norm(avg_complexity, 10) + 0.5·norm(max_complexity, 30)` |
| coupling | `norm(fan_in + fan_out, 20)` |
| churn | `0.5·norm(commits, 10) + 0.5·norm(lines_changed / loc, 1.0)` — normalized per line so big files aren't penalized for size |
| duplication | duplicated-line percentage (windowed 6-line clone detection) |
| entropy index | `0.30·complexity + 0.30·coupling + 0.25·churn + 0.15·duplication` (weights in `[entropy]`) |
| hotspot | `0.35·complexity + 0.35·coupling + 0.30·churn` (weights in `[hotspots]`) |

Global summary scores are LOC-weighted means of per-file scores, so each
file's `entropy_contribution` sums to the global index.

Complexity is a cyclomatic proxy: decision tokens (`if`/`for`/`while`/`case`/
`catch`/`&&`/`||`/`??` for TS; `if`/`while`/`loop`/`for`/`&&`/`||`/match-arm
`=>` for Rust) counted per function via regex heuristics — deterministic and
explainable, not AST-exact.

## Architecture

```
src/
  cli.ts              command dispatch (no framework)
  analyze.ts          orchestration, scoring, hotspots, cycle detection
  languages/
    analyzer.ts       LanguageAnalyzer interface + shared helpers
    rust.ts           mod/use resolution, fn complexity
    typescript.ts     import/export resolution, function complexity
  git.ts              churn via `git log --numstat`
  duplication.ts      isolated windowed clone detector (swappable)
  storage.ts          SQLite snapshots (.entropy/entropy.db)
  report.ts           text / markdown rendering
  config.ts, toml.ts  config load/init
```

Adding a language = implement `LanguageAnalyzer` (detect / complexity /
dependencies / normalizedLines) and register it in `languages/index.ts`.
The engine never sees language-specific structures.

The JSON report (`report --format json`, `"version": 1`) plus the SQLite
schema (`snapshots`, `file_metrics`) carry everything a future agent needs
for `get_repository_summary`, `get_file_metrics`, `get_hotspots`,
`get_history`, `get_dependencies` (per-file internal deps are recomputed on
demand by `entropy file`).

## Known MVP limits

- Complexity/function detection is regex-heuristic (no ternary counting in TS;
  inline callbacks attribute to the enclosing function).
- TS path aliases (`tsconfig` `paths`) count as external imports.
- Duplication is a 6-line normalized-window detector — isolated in
  `duplication.ts` for later replacement.

## Tests

```bash
bun test   # 26 tests: complexity, deps, coupling, churn, duplication,
           # normalization, entropy, hotspots, persistence, history,
           # JSON schema, determinism
```
