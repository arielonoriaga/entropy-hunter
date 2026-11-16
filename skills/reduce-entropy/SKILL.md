---
name: reduce-entropy
description: Use when asked to reduce software entropy, clean up hotspots, or improve structural health of a repo — and whenever `entropy check` (or the harness gate that runs it) reports that files you changed regressed. Drives the `entropy` CLI in a measure → zoom out → refactor → re-measure loop, with tests green at every step.
---

# Reduce Entropy

You drive the `entropy` CLI (must be on PATH; see https://github.com/arielonoriaga/entropy-hunter).
Every score is a deterministic heuristic traceable to raw facts — a pointer to
a real problem, never the goal. **Never refactor to move a score.** A change
that lowers the number without making the code easier to change is a regression
the tool cannot see.

## Pick the scope

1st. **The gate sent you, or you are about to deliver work** → session scope.
     `entropy check` judges only the files that changed, each against its own
     state at the base commit. Fix what it fails; leave the rest of the repo alone.
2nd. **You were asked to improve a repo's health** → repo scope. Work the
     hotspot loop below, one target per commit.

`entropy check` exits 1 on a regression. Its findings name the function, the
clone partner or the import that caused it — start from the finding, not from
the score.

## Zoom out before you touch code

The file a finding points at is where the problem *surfaces*. Before editing,
find the level that *owns* it — fixing below that level produces five leaf
patches where one root fix was needed.

Climb in this order and stop at the first level that owns the cause:

1st. **Function** — is this complexity essential (the domain really has these
     rules) or accidental (plumbing, flags, repeated guards)? Only accidental
     complexity is yours to remove.
2nd. **File** — `entropy file <path>`. Does it have one reason to change?
     Which raw fact drives it: one function, the imports, a type's optional fields?
3rd. **Module** — `entropy zoom <path>`. Is this file an outlier among calm
     siblings, or does the whole directory look like this?
4th. **System** — does this module depend in the right direction, and does it
     own what it uses? Cycles, layer violations and reach live here.
5th. **Existence** — what breaks if this is deleted? An orphan, a second copy
     of a capability, or a layer that only forwards calls may not need fixing
     at all.

`entropy zoom <path>` does steps 3–4 for you: it prints the ladder file →
module → repository with a *lens* at each level and a `Fix at:` line naming the
outermost level that owns a cause.

| Lens | What it means | The move |
|---|---|---|
| `local` | outlier among its siblings | fix this file: extract, guard clauses, name the constants |
| `pattern` | most files of the module share the same hot signal | add the missing abstraction or convention once, then migrate |
| `boundary` | most of the module's dependencies cross its edge | move code across the seam, or invert the dependency |
| `shared-home` | files clone code that lives outside the module | extract it to the nearest common parent |
| `concentrated` | one file carries the module | the module is fine — go back down to that file |
| `healthy` | nothing systemic here | stop climbing |

Then zoom back in: state the **one** change, at that level, and which raw fact
it will move. If you cannot name the fact, you have not found the cause yet.

> Example — the gate fails `orders/service.ts` on duplication, shared with
> `quotes/service.ts`. `entropy zoom orders/service.ts` shows `shared-home` on
> `src/`: three modules carry the same tax rounding. Deduplicating inside
> `orders/` would leave two copies behind; the fix is one `src/money/rounding.ts`
> that all three import. *(Demonstrates: the finding named a file, the cause
> lived two levels up.)*

## Repo-scope loop

1. **Baseline.** `entropy init` (once per repo), `entropy snapshot`, then
   `entropy report --format json`. Record `summary.entropy` and the per-signal
   scores. Non-TTY runs print no progress noise; stdout is pure JSON.
2. **See the terrain.** `entropy zoom` lists modules by their share of the
   repo's entropy. Prefer a module-level cause over a file-level symptom.
3. **Pick ONE target.** `entropy priority --limit 10 --format json` (dangerous:
   messy *and* widely depended on) or `entropy hotspots`. Skip generated code,
   vendored files, and files with no test coverage you cannot add.
4. **Zoom out** as above. If the signal is legitimate — high coupling on a
   facade, churn on a feature in active development — pick the next target
   and note why this one was skipped.
5. **Refactor at the owning level**, smallest coherent change:
   - complexity → extract functions, guard clauses, replace nested branching
   - coupling → invert dependencies, split the module along its seams
   - duplication → extract at the 2nd proven duplicate; `duplicate_partners`
     in `entropy file` names where the copies are
   - cycle → break the edge that points the wrong way, not whichever is easiest
   - churn is context, not something to "fix" directly
   Keep behavior identical. Run the project's test suite; it must stay green.
6. **Re-measure.** `entropy check` must pass, and the target's raw fact must
   have moved. Then commit (conventional commit, e.g. `refactor(orders):
   extract pricing rules from service`) and `entropy snapshot`.
7. **Repeat** from step 3, or stop when: the requested budget is spent, the
   remaining targets are legitimate signals, or two consecutive attempts
   produced < 1 point of improvement.

## Accepting a regression

Some regressions are the right call: a lookup table, a parser whose branching
*is* the grammar, a feature that genuinely needs the new dependency. Then, and
only then:

```bash
entropy check --accept <path> --reason "<why this is legitimate>"
```

The acceptance is bound to the file's exact content — any later edit is judged
again. Always tell the user what you accepted and why; an acceptance they never
hear about is a hidden regression. Never accept to get past the gate when the
honest answer is "I did not get to it" — say that instead.

## Report back

End with: entropy before → after, per-signal deltas, files changed with a
one-line rationale each, the level each fix was aimed at and why, anything
accepted or skipped and why, and (repo scope) `entropy history`.

## Hard rules

- One target per commit; tests green before and after every commit.
- No behavior changes, no API breaks, no dependency additions.
- If tests are missing for the target, write the safety-net test FIRST.
- If a refactor fails twice, revert and move on — do not force it.
