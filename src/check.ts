// `entropy check`: did THIS change make the code worse?
//
// Compares every changed file against its own state at a base commit, both
// sides measured by the same engine with the same churn data, and applies a
// small fixed rule table — like `entropy health`, deterministic thresholds
// over raw facts, not judgment. The verdict is what a hook or CI gate keys on.
import { statSync } from "node:fs";
import { join } from "node:path";
import { analyzeTree, loadChurn, type ProgressFn } from "./analyze";
import { commentFindings } from "./comment-gate";
import { changedLines, changedSince, resolveBase, type LineChanges } from "./git";
import { analyzerFor } from "./languages";
import type { Storage } from "./storage";
import { treeAt, workingTree } from "./tree";
import { SIGNALS, type EntropyConfig, type FileMetrics, type Signal } from "./types";

export type Level = "fail" | "warn";
export type FileVerdict = "pass" | "warn" | "fail" | "waived";

export interface Finding {
  rule: string;
  level: Level;
  message: string;
}

export interface CheckedFile {
  path: string;
  status: "added" | "modified" | "renamed";
  base_path: string | null;
  entropy_before: number | null; // null for a file that did not exist at base
  entropy_after: number;
  delta: number;
  verdict: FileVerdict;
  waiver: string | null; // the recorded reason, when verdict is "waived"
  findings: Finding[];
}

export interface CheckResult {
  version: 1;
  base: { ref: string; commit: string };
  verdict: "pass" | "fail";
  summary: {
    files_changed: number;
    failed: number;
    warned: number;
    waived: number;
    entropy_before: number;
    entropy_after: number;
  };
  files: CheckedFile[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
// A signal is worth a warning when it rises this much AND lands in the
// attention band (same boundary as `entropy health`).
const SIGNAL_WARN_DELTA = 10;
const ATTENTION = 30;
// Signals with a dedicated rule above, or whose rise the file did not cause
// (churn is history; reach and coupling move when OTHER files import this one).
const UNWARNED_SIGNALS = new Set<Signal>([
  "complexity", "duplication", "architecture", "nesting", "churn", "reach", "coupling",
  "deadcode", "test",
]);

interface Sides {
  before: FileMetrics | null;
  after: FileMetrics;
  after_by_path: Map<string, FileMetrics>;
  config: EntropyConfig;
  changes: LineChanges | null;
}
type Rule = (sides: Sides) => Finding[];

const fail = (rule: string, message: string): Finding => ({ rule, level: "fail", message });
const warn = (rule: string, message: string): Finding => ({ rule, level: "warn", message });

// The rule table. Every rule compares raw facts of one file before and
// after, so each finding names something concrete to change.
const RULES: Rule[] = [
  function complexity({ before, after, config }) {
    const limit = config.gate.function_complexity;
    const was = new Map((before?.functions ?? []).map((f) => [f.name, f.complexity]));
    // A function that appears while an at-least-as-complex one disappears or
    // shrinks is a rename or an extraction within the file, not new complexity.
    const now = new Map(after.functions.map((f) => [f.name, f.complexity]));
    const donated = Math.max(
      0,
      ...(before?.functions ?? [])
        .filter((f) => (now.get(f.name) ?? 0) < f.complexity)
        .map((f) => f.complexity),
    );
    return after.functions
      .filter((f) => f.complexity > limit && f.complexity > (was.get(f.name) ?? donated))
      .map((f) =>
        fail(
          "complexity",
          was.has(f.name)
            ? `function \`${f.name}\` (line ${f.line}) complexity ${was.get(f.name)} → ${f.complexity} (limit ${limit})`
            : `new function \`${f.name}\` (line ${f.line}) has complexity ${f.complexity} (limit ${limit})`,
        ),
      );
  },

  function duplication({ before, after, config }) {
    const added = after.duplicated_lines - (before?.duplicated_lines ?? 0);
    if (added < config.gate.new_duplicated_lines) return [];
    const partners = after.duplicate_partners.length
      ? ` — shared with ${after.duplicate_partners.join(", ")}`
      : " — repeated within this file";
    return [fail("duplication", `+${added} duplicated lines${partners}`)];
  },

  function cycle({ before, after, after_by_path }) {
    if (!after.in_cycle || before?.in_cycle) return [];
    const through = after.dependencies.filter((d) => after_by_path.get(d)?.in_cycle);
    return [fail("cycle", `now part of a dependency cycle (through ${through.join(", ") || "its imports"})`)];
  },

  function architecture({ before, after }) {
    const was = before?.arch_violations ?? 0;
    if (after.arch_violations <= was) return [];
    return [fail("architecture", `inner→outer layer imports ${was} → ${after.arch_violations}`)];
  },

  function nesting({ before, after, config }) {
    const limit = config.gate.nesting_depth;
    const was = before?.max_nesting ?? 0;
    if (after.max_nesting <= limit || after.max_nesting <= was) return [];
    const where = [...after.functions].reverse().find((f) => f.line <= after.nesting_line);
    return [
      fail(
        "nesting",
        `control flow nested ${was} → ${after.max_nesting} deep at line ${after.nesting_line}${
          where ? ` (in \`${where.name}\`)` : ""
        } (limit ${limit}) — flatten with guard clauses / early returns`,
      ),
    ];
  },

  function entropy({ before, after, config }) {
    if (!before) {
      const limit = config.gate.new_file_entropy;
      return after.entropy_score >= limit
        ? [fail("entropy", `new file starts at entropy ${after.entropy_score} (limit ${limit}) — ${after.why}`)]
        : [];
    }
    const delta = round1(after.entropy_score - before.entropy_score);
    return delta >= config.gate.max_file_delta
      ? [fail("entropy", `entropy ${before.entropy_score} → ${after.entropy_score} (+${delta}, limit +${config.gate.max_file_delta})`)]
      : [];
  },

  function untested({ before, after, config }) {
    const exposed = !after.has_test && !after.is_entrypoint &&
      after.complexity_total >= config.scoring.test_complexity_cap;
    if (!exposed || (before && !before.has_test)) return []; // already untested before: not this change's doing
    return [warn("untested", `complexity ${after.complexity_total} with no test covering it`)];
  },

  function comments({ after, changes }) {
    if (!changes) return [];
    return commentFindings(after.functions, after.comment_lines, changes).map((message) => fail("comments", message));
  },

  function orphan({ before, after }) {
    if (before || !after.is_orphan) return [];
    return [warn("orphan", "new file that nothing imports (and is not a recognized entrypoint)")];
  },

  function signals({ before, after }) {
    return SIGNALS.filter((signal) => !UNWARNED_SIGNALS.has(signal)).flatMap((signal) => {
      const was = before?.[`${signal}_score`] ?? 0;
      const now = after[`${signal}_score`];
      return now >= ATTENTION && now - was >= SIGNAL_WARN_DELTA
        ? [warn(signal, `${signal} score ${was} → ${now}${SIGNAL_FACT[signal]?.(after) ?? ""}`)]
        : [];
    });
  },
];

// The raw fact behind a signal's score, so a warning says what to look at.
const SIGNAL_FACT: Partial<Record<Signal, (f: FileMetrics) => string>> = {
  state: (f) => ` (${f.max_state_fields} optional/boolean fields in one type)`,
  clumping: (f) => ` (${f.max_clump_fields} fields prefixed \`${f.clump_prefix}\` in one type)`,
  magic: (f) => ` (${f.magic_numbers} magic numbers, ${f.magic_strings} magic strings)`,
  guard: (f) => ` (${f.max_guard_group} sibling ifs re-checking \`${f.guard_prefix}\`)`,
  semantic: (f) => ` (Option nesting depth ${f.max_optional_depth})`,
};

// --- waivers -----------------------------------------------------------------
// A failing file can be accepted with a recorded reason. The waiver is bound
// to the file's exact content: any further edit puts it back under the gate.

const WAIVER_PREFIX = "waiver:";

interface Waiver {
  content_hash: string;
  reason: string;
  at: string;
}

const contentHash = (source: string) => String(Bun.hash(source));

function waiverFor(storage: Storage | null, path: string, source: string | null): Waiver | null {
  const raw = storage?.kvGet(WAIVER_PREFIX + path);
  if (!raw || source === null) return null;
  const waiver: Waiver = JSON.parse(raw);
  return waiver.content_hash === contentHash(source) ? waiver : null;
}

export function recordWaiver(storage: Storage, repo: string, path: string, reason: string): void {
  const source = workingTree(repo).read(path);
  if (source === null) throw new CheckError(`cannot waive ${path}: file not found`);
  const waiver: Waiver = { content_hash: contentHash(source), reason, at: new Date().toISOString() };
  storage.kvSet(WAIVER_PREFIX + path, JSON.stringify(waiver));
}

export class CheckError extends Error {}

// --- the check ---------------------------------------------------------------

export interface CheckOptions {
  base: string; // a commit-ish, or "auto"
  since: string;
  // Restrict the verdict to these repo-relative paths; null = every changed file.
  only: string[] | null;
  // Restrict the verdict to files modified at or after this instant (ms) —
  // "what was touched since this work session began", however it was
  // edited. null = no restriction.
  touchedSince: number | null;
}

const commentGateApplies = (config: EntropyConfig, after: FileMetrics) =>
  config.gate.comments && after.comment_lines.length > 0;

export function checkRepo(
  repo: string,
  config: EntropyConfig,
  options: CheckOptions,
  storage: Storage | null,
  progress: ProgressFn | null,
): CheckResult {
  const commit = resolveBase(repo, options.base);
  const diff = changedSince(repo, commit);
  const only = options.only && new Set(options.only.map((p) => p.replace(/^\.\//, "")));
  const touched = (path: string) =>
    options.touchedSince === null ||
    (statSync(join(repo, path), { throwIfNoEntry: false })?.mtimeMs ?? 0) >= options.touchedSince;
  const candidates = diff.changed.filter(
    (c) => analyzerFor(c.path) !== null && (!only || only.has(c.path)) && touched(c.path),
  );

  const result: CheckResult = {
    version: 1,
    base: { ref: options.base, commit },
    verdict: "pass",
    summary: { files_changed: 0, failed: 0, warned: 0, waived: 0, entropy_before: 0, entropy_after: 0 },
    files: [],
  };
  if (!candidates.length) return result;

  const churnSharedByBothSides = loadChurn(repo, options.since, storage, progress);
  const tree = workingTree(repo);
  const head = analyzeTree(repo, tree, config, churnSharedByBothSides, { storage, memo: null, progress });
  progress?.("analyzing base…");
  const base = analyzeTree(repo, treeAt(repo, commit, diff), config, churnSharedByBothSides, {
    storage: null, memo: head.memo, progress: null,
  });

  const after_by_path = new Map(head.result.files.map((f) => [f.path, f]));
  const before_by_path = new Map(base.result.files.map((f) => [f.path, f]));
  for (const change of candidates) {
    const after = after_by_path.get(change.path);
    if (!after) continue;
    const before = change.base_path ? before_by_path.get(change.base_path) ?? null : null;
    const changes = commentGateApplies(config, after) ? changedLines(repo, commit, change) : null;
    const findings = RULES.flatMap((rule) => rule({ before, after, after_by_path, config, changes }));
    const failed = findings.some((f) => f.level === "fail");
    const waiver = failed ? waiverFor(storage, change.path, tree.read(change.path)) : null;
    result.files.push({
      path: change.path,
      status: !before ? "added" : change.base_path !== change.path ? "renamed" : "modified",
      base_path: change.base_path,
      entropy_before: before?.entropy_score ?? null,
      entropy_after: after.entropy_score,
      delta: round1(after.entropy_score - (before?.entropy_score ?? 0)),
      verdict: waiver ? "waived" : failed ? "fail" : findings.length ? "warn" : "pass",
      waiver: waiver?.reason ?? null,
      findings,
    });
  }

  const count = (verdict: FileVerdict) => result.files.filter((f) => f.verdict === verdict).length;
  result.summary = {
    files_changed: result.files.length,
    failed: count("fail"),
    warned: count("warn"),
    waived: count("waived"),
    entropy_before: base.result.summary.entropy,
    entropy_after: head.result.summary.entropy,
  };
  result.verdict = result.summary.failed ? "fail" : "pass";
  return result;
}
