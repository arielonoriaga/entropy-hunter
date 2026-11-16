import type { AliasResolver } from "../aliases";
import { NO_ALIASES } from "../aliases";
import type { FunctionComplexity } from "../types";

export interface ComplexityResult {
  total: number;
  average: number;
  max: number;
  functions: FunctionComplexity[];
}

export interface DependencyResult {
  internal: string[]; // repo-relative resolved paths
  external: string[]; // package/crate specifiers
}

// Shape analysis of one declared type.
// - optional/boolean fields: each roughly doubles the representable states
//   ("make illegal states unrepresentable" — sum types keep this at 0).
// - clump: largest group of fields sharing a name prefix (order_id,
//   order_date, order_total → a flattened Order entity wanting extraction).
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
  is_pub: boolean; // is this type's declaration `pub` (public API surface)?
}

const MIN_CLUMP = 3; // 2 shared prefixes can be coincidence; 3 is a pattern
// Not evidence of a flattened entity:
// - boolean-ish prefixes (is_/has_) describe state — the state signal's job
// - accessor/callback prefixes (on*/set*/get*/handle*) are idioms, not entities
const CLUMP_STOPWORDS = new Set([
  "is", "has", "can", "should", "was", "will",
  "on", "set", "get", "handle",
]);

// Largest group of field names sharing a first segment (snake_case or
// camelCase). Only composite names count — a field named just `order`
// isn't evidence of a flattened Order.
export function largestPrefixClump(fieldNames: string[]): { prefix: string; fields: number } {
  const groups = new Map<string, number>();
  for (const name of fieldNames) {
    const prefix = name.split(/_|(?=[A-Z])/)[0].toLowerCase();
    if (!prefix || prefix === name.toLowerCase()) continue; // not composite
    if (CLUMP_STOPWORDS.has(prefix)) continue;
    groups.set(prefix, (groups.get(prefix) ?? 0) + 1);
  }
  let best: { prefix: string; fields: number } = { prefix: "", fields: 0 };
  for (const [prefix, fields] of [...groups].sort()) {
    if (fields >= MIN_CLUMP && fields > best.fields) best = { prefix, fields };
  }
  return best;
}

// Field names in a struct/interface body: identifier directly followed by
// `:` (or `?:`). Methods (`foo(): T`) don't match — `(` breaks adjacency.
export function fieldNames(body: string): string[] {
  return [...body.matchAll(/([A-Za-z_$][\w$]*)\s*\??:/g)].map((m) => m[1]);
}

// Sibling `if`s sharing a leading `&&` conjunct — the same guard is being
// re-evaluated N times instead of checked once with nested/early-return
// branches inside (Fowler's "Consolidate Conditional Expression").
export interface ConditionGroup {
  prefix: string;
  count: number;
  lines: number[];
}

const MIN_GROUP = 2;
const NEARBY_LINES = 20; // how close two ifs must be to count as "siblings"

// ifPattern must capture exactly (indent, condition text) and match a
// same-line `if` header (paren-style for TS/generic, bare for Rust).
// conjunctSplit: how "and" is spelled — `&&` for C-like languages, also
// `\band\b` for Python/Ruby-family (passed by the generic analyzer).
export function findSharedConditionGroups(
  stripped: string,
  ifPattern: RegExp,
  conjunctSplit: RegExp = /&&/,
): ConditionGroup[] {
  const lines = stripped.split("\n");
  const hits: { indent: string; prefix: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ifPattern);
    if (!m) continue;
    const conjuncts = m[2].split(conjunctSplit).map((s) => s.trim()).filter(Boolean);
    // Need a leading guard AND something else after it — a bare repeated
    // condition with nothing else is plain duplication, not this smell.
    if (conjuncts.length < 2) continue;
    hits.push({ indent: m[1], prefix: conjuncts[0], line: i + 1 });
  }

  const groups: ConditionGroup[] = [];
  let i = 0;
  while (i < hits.length) {
    let j = i + 1;
    while (
      j < hits.length &&
      hits[j].indent === hits[i].indent &&
      hits[j].prefix === hits[i].prefix &&
      hits[j].line - hits[j - 1].line <= NEARBY_LINES
    ) {
      j++;
    }
    const size = j - i;
    if (size >= MIN_GROUP) {
      groups.push({ prefix: hits[i].prefix, count: size, lines: hits.slice(i, j).map((h) => h.line) });
    }
    i = j > i + 1 ? j : i + 1;
  }
  return groups;
}

// Magic literals in logic positions. Numbers: bare numeric literals outside
// named-constant declarations, excluding conventional 0/1/2. Strings:
// literals used in comparisons or case/match arms — stringly-typed logic
// that wants to be an enum. Named constants are the fix, so they don't count.
// Repeated visible JSX text is counted too: copy duplicated across buttons or
// labels should live in a dictionary instead of drifting between screens.
// Chained equality comparisons against the SAME identifier — `x !== "a" &&
// x !== "b" && x !== "c"` — are the sharpest form of this smell: every
// individual `!== "lit"` already counts once via STRING_COMPARE, but a
// chain of 3+ against one identifier is specifically the shape that
// collapses into a single `SET.has(x)`/`!SET.has(x)`, and scattered
// comparisons across unrelated identifiers don't share that fix. Counted
// per chain (not per comparison in it) as an aggravating addition on top.
const ALLOWED_NUMBERS = new Set(["0", "1", "2"]);
const NUMBER = /(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g;
const STRING_COMPARE = /[=!]={1,2}\s*(['"])(?:\\.|(?!\1).)+\1/g;
const STRING_ARM = /\bcase\s+(['"])|(['"])(?:\\.|(?!\2).)+\2\s*=>/g;
const JSX_TEXT = />\s*([^<>{}\n][^<>{}\n]*?)\s*</g;
const CHAINED_COMPARISON =
  /([A-Za-z_$][\w$]*(?:\([^()]*\))?)\s*[!=]==?\s*(['"])(?:\\.|(?!\2).)+\2(?:\s*&&\s*\1\s*[!=]==?\s*(['"])(?:\\.|(?!\3).)+\3){2,}/g;

// A chain of 3 comparisons has 2 of them directly followed by `&&`.
const MIN_CHAIN_LINKS = 2;
const COMPARISON_THEN_AND = /[!=]==?\s*(['"])(?:\\.|(?!\1).)+\1\s*&&/g;
const STRING_BEFORE_ARROW = /['"]\s*=>/;
const CASE_ARM = /\bcase\s+['"]/g; // STRING_ARM's first alternative on its own

export function countChainedComparisons(source: string): number {
  return (source.match(CHAINED_COMPARISON) ?? []).length;
}

export function countRepeatedJsxText(source: string): number {
  const counts = new Map<string, number>();
  for (const match of source.matchAll(JSX_TEXT)) {
    const text = match[1].replace(/\s+/g, " ").trim();
    if (text.length < 3) continue;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
}

// Net brace balance of a line (opens minus closes) — used to track whether
// a multi-line object literal body is still open.
function braceDelta(line: string): number {
  return (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
}

export function countMagic(
  numbersView: string, // comments AND string contents blanked
  stringsView: string, // comments blanked, string contents kept
  constDeclLine: RegExp, // lines declaring named constants — exempt
): { numbers: number; strings: number } {
  let numbers = 0;
  let constBlockDepth = 0; // >0 while inside a multi-line const object literal
  for (const line of numbersView.split("\n")) {
    const isConstDecl = constDeclLine.test(line);
    if (isConstDecl || constBlockDepth > 0) {
      constBlockDepth = Math.max(0, constBlockDepth + braceDelta(line));
      continue; // const declarations and every field nested inside are exempt
    }
    for (const m of line.match(NUMBER) ?? []) {
      if (!ALLOWED_NUMBERS.has(m)) numbers++;
    }
  }
  // The arm and chain patterns try a match at every quote / identifier, which
  // dominates a cold run; each is skipped when a cheap necessary condition
  // (a string directly before `=>`; two comparisons each followed by `&&`)
  // already rules a match out.
  const arms = STRING_BEFORE_ARROW.test(stringsView)
    ? (stringsView.match(STRING_ARM) ?? []).length
    : (stringsView.match(CASE_ARM) ?? []).length;
  const chains =
    (stringsView.match(COMPARISON_THEN_AND) ?? []).length >= MIN_CHAIN_LINKS
      ? countChainedComparisons(stringsView)
      : 0;
  const strings =
    (stringsView.match(STRING_COMPARE) ?? []).length + arms + countRepeatedJsxText(stringsView) + chains;
  return { numbers, strings };
}

// Common interface every language plugin implements. The core engine only
// sees this — no language-specific AST leaks past this boundary.
export interface LanguageAnalyzer {
  language: string;
  detect(path: string): boolean;
  complexity(source: string): ComplexityResult;
  // Dependencies come in two halves so the expensive one is cacheable:
  // imports() reads only the file's content (cached per content hash);
  // resolve() maps those specifiers onto the current file set, which is
  // cheap and must be redone whenever any file is added or removed.
  // Specifier encoding is private to each plugin.
  imports(source: string): string[];
  // fileSet: all repo-relative analyzed paths, for resolving internal deps.
  resolve(imports: string[], path: string, fileSet: Set<string>, aliases: AliasResolver): DependencyResult;
  // Lines eligible for duplication detection: normalized, trivia removed.
  normalizedLines(source: string): { line: number; text: string }[];
  // Declared data types and their optional/boolean field counts.
  stateSpace(source: string): TypeState[];
  // Magic-literal counts (numbers in logic, strings in comparisons/arms).
  magic(source: string): { numbers: number; strings: number };
  // Sibling ifs sharing a leading guard conjunct — see findSharedConditionGroups.
  sharedConditions(source: string): ConditionGroup[];
  // Does this file have a corresponding test (companion file or, for Rust,
  // an inline #[cfg(test)] module)? fileSet enables companion-file lookup.
  testCoverage(source: string, path: string, fileSet: Set<string>): TestCoverage;
}

// One-shot dependency extraction, for callers without a cache or aliases.
export function dependenciesOf(
  analyzer: LanguageAnalyzer,
  source: string,
  path: string,
  fileSet: Set<string>,
  aliases: AliasResolver = NO_ALIASES,
): DependencyResult {
  return analyzer.resolve(analyzer.imports(source), path, fileSet, aliases);
}

export interface TestCoverage {
  has_test: boolean;
  test_path: string; // companion file path, "(inline)" for Rust, "" if none
}

// A file IS a test itself — by naming convention, shared across all
// languages entropy-hunter analyzes. Single source of truth: also used to
// decide whether a file NEEDS a companion test (a test doesn't need one).
export function isTestFile(path: string): boolean {
  const base = path.split("/").pop()!;
  return (
    /\.(test|spec)\.[\w.]+$/.test(base) || // foo.test.ts, foo.spec.ts
    /_test\.go$/.test(base) || // Go convention
    /(^test_|_test)\.py$/.test(base) || // Python convention (either order)
    /(_tests?|^tests?)\.rs$/.test(base) || // Rust file wholly dedicated to tests
    /(^|\/)(tests|__tests__)\//.test(path)
  );
}

// Extract `{...}` bodies whose opening brace is matched by `header`
// (header's last matched char must be the `{`). Brace-counted on stripped
// source, so strings/comments can't unbalance it.
export function extractBraceBlocks(
  stripped: string,
  header: RegExp,
): { name: string; body: string }[] {
  const blocks: { name: string; body: string }[] = [];
  for (const m of stripped.matchAll(header)) {
    const name = m.slice(1).find((g) => g !== undefined) ?? "<anonymous>";
    let depth = 1;
    const start = m.index! + m[0].length;
    let i = start;
    while (i < stripped.length && depth > 0) {
      if (stripped[i] === "{") depth++;
      else if (stripped[i] === "}") depth--;
      i++;
    }
    blocks.push({ name, body: stripped.slice(start, i - 1) });
  }
  return blocks;
}

// Shared helper: attribute decision tokens to the enclosing function.
// Heuristic, not AST-exact: each function starts at complexity 1; decision
// tokens found after a function header (until the next header) belong to it.
export function complexityFromMarkers(
  stripped: string,
  functionHeader: RegExp,
  decisionToken: RegExp,
): ComplexityResult {
  const functions: FunctionComplexity[] = [];
  // Parallel to `functions`: does this header's own line open a block body
  // (ends with `{`)? A single-expression arrow (`const f = x => x + 1`) has
  // none — it must not "capture" attribution for the lines that follow it,
  // or a trivial one-line helper declared mid-function silently steals every
  // decision point in the code that comes after it until the next header.
  const hasBody: boolean[] = [];
  const lines = stripped.split("\n");
  for (let ln = 0; ln < lines.length; ln++) {
    functionHeader.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = functionHeader.exec(lines[ln])) !== null) {
      // Multi-alternative regexes put the name in whichever group matched.
      const name = m.slice(1).find((g) => g !== undefined) ?? "<anonymous>";
      functions.push({ name, complexity: 1, line: ln + 1 });
      // A `function` declaration/expression or a same-line method header is
      // always block-bodied by JS/TS grammar even when its own signature
      // spans multiple lines (checking only THIS line for a trailing `{`
      // would wrongly call it bodyless). Only a bare arrow assignment
      // (header text ending in `=>`) can have an expression body instead —
      // for those, body-ness is whatever immediately follows on this line.
      const isArrow = /=>\s*$/.test(m[0]);
      const restOfLine = lines[ln].slice(m.index! + m[0].length);
      hasBody.push(!isArrow || /^\s*\{/.test(restOfLine));
    }
  }
  let fi = -1; // most recent header passed, whether or not it owns a body
  let active = -1; // the block-bodied function currently attributing lines
  let unattributed = 0;
  for (let ln = 0; ln < lines.length; ln++) {
    while (fi + 1 < functions.length && functions[fi + 1].line === ln + 1) {
      fi++;
      if (hasBody[fi]) active = fi;
    }
    const onHeaderLine = fi >= 0 && functions[fi].line === ln + 1;
    const target = onHeaderLine && !hasBody[fi] ? fi : active;
    const count = lines[ln].match(decisionToken)?.length ?? 0;
    if (target < 0) unattributed += count;
    else functions[target].complexity += count;
  }
  // Decision points outside any function (top-level module code).
  if (unattributed > 0) {
    functions.unshift({ name: "<module>", complexity: 1 + unattributed, line: 0 });
  }
  const total = functions.reduce((s, f) => s + f.complexity, 0);
  return {
    total,
    average: functions.length ? total / functions.length : 0,
    max: functions.reduce((s, f) => Math.max(s, f.complexity), 0),
    functions,
  };
}

const UNCOLLAPSED_WHITESPACE = /\s\s|[^\S ]/;
const HAS_WORD = /\w/;

export function normalizedLinesFrom(stripped: string): { line: number; text: string }[] {
  const result: { line: number; text: string }[] = [];
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.length < 3) continue;
    // Most lines have only single spaces inside — nothing to collapse.
    const t = UNCOLLAPSED_WHITESPACE.test(trimmed) ? trimmed.replace(/\s+/g, " ") : trimmed;
    // Skip lines with nothing but punctuation — lone braces/brackets, and
    // string literals whose contents were blanked (`" ",`). They repeat
    // everywhere without meaning anything: any two string tables would
    // otherwise "duplicate" each other.
    if (!HAS_WORD.test(t)) continue;
    result.push({ line: i + 1, text: t });
  }
  return result;
}
