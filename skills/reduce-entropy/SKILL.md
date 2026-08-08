---
name: reduce-entropy
description: Use when asked to reduce software entropy, clean up hotspots, or improve structural health of a repo. Drives the `entropy` CLI in a measure → refactor → re-measure loop, one hotspot at a time, with tests green at every step.
---

# Reduce Entropy

You drive the `entropy` CLI (must be on PATH; see https://github.com/arielonoriaga/entropy-hunter).
All scores are deterministic heuristics traceable to raw metrics — treat them
as pointers to real problems, never as the goal itself. **Never refactor to
game the score.**

## Loop

1. **Baseline.** `entropy init` (once per repo), then `entropy snapshot` and
   `entropy report --format json`. Record `summary.entropy` and the per-metric
   scores. Non-TTY runs print no progress noise; stdout is pure JSON.

2. **Pick ONE target.** `entropy hotspots --limit 10 --format json`.
   Choose the top hotspot you can safely change (skip generated code,
   vendored files, files with no test coverage you cannot add).

3. **Investigate before editing.**
   - `entropy file <path> --format json` → raw facts: which functions are
     complex (`functions[]`), who it depends on (`dependencies`), who depends
     on it (`dependents`), churn, duplication.
   - Read the file and its tests. Understand WHY the metric is high — high
     coupling may be legitimate (a facade), high churn may be a feature in
     active development. If the signal is legitimate, pick the next hotspot
     and note why this one was skipped.

4. **Refactor at the root cause**, smallest coherent change:
   - complexity → extract functions, guard clauses, replace nested branching
   - coupling → invert dependencies, split the module along its seams
   - duplication → extract at the 2nd proven duplicate, not speculatively
   - churn is context, not something to "fix" directly
   Keep behavior identical. Run the project's test suite; it must stay green.

5. **Re-measure.** `entropy analyze` — confirm `summary.entropy` and the
   target file's scores moved down and nothing else regressed. Then commit
   (conventional commit, e.g. `refactor(orders): extract pricing rules from
   service`) and `entropy snapshot`.

6. **Repeat** from step 2, or stop when: the requested budget is spent, the
   remaining hotspots are legitimate signals, or two consecutive attempts
   produced < 1 point of improvement.

## Report back

End with: entropy before → after, per-metric deltas, files changed with a
one-line rationale each, hotspots deliberately skipped and why, and
`entropy history` output showing the trend.

## Hard rules

- One hotspot per commit; tests green before and after every commit.
- No behavior changes, no API breaks, no dependency additions.
- If tests are missing for the target, write the safety-net test FIRST.
- If a refactor fails twice, revert and move on — do not force it.
