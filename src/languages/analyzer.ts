import type { AliasResolver } from "../aliases";
import { NO_ALIASES } from "../aliases";
import type { CommentFacts } from "./comments";
import type { FunctionComplexity } from "../types";
import { lineAt, lineStartsOf } from "./strip";

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

// Deepest control-flow nesting in a file: how many if/for/while/match/try
// blocks enclose the most deeply buried statement. Blocks that are not
// control flow — function bodies, object literals, closures, type bodies —
// do not count, so a method in a class in a module starts at 0.
export interface Nesting {
  depth: number;
  line: number; // where that depth is first reached (0 if depth is 0)
}

// The text that opens a block is control flow when it starts with one of
// these keywords — optionally after a closing brace (`} else {`), a loop
// label, or an assignment/return taking the block's value (`let x = match`).
const CONTROL_HEAD =
  /^(?:'\w+\s*:\s*)?(?:(?:let|const|var|return|yield|await)\b[^=]*=?\s*|[\w.[\]]+\s*=\s*)?(?:else\s+)?(?:if|for|while|switch|try|catch|finally|do|else|loop|match)\b/;
const BLOCK_DELIMITER = /[(){};\n]/g;

// Brace-delimited languages, on stripped source. A block's head is the text
// since the last statement boundary; parentheses are tracked so that braces
// inside a condition or an argument list (object literals, callbacks) are
// neither mistaken for the block nor allowed to cut its head short.
export function braceNesting(stripped: string): Nesting {
  // One frame per open brace. `paren`: paren depth when it opened — the
  // level at which `;` separates statements inside it. `resume`: for a brace
  // opened inside parentheses, where the interrupted head started.
  const frames: { control: boolean; paren: number; resume: number }[] = [];
  let paren = 0;
  let headStart = 0;
  let depth = 0;
  let line = 1;
  const worst: Nesting = { depth: 0, line: 0 };

  BLOCK_DELIMITER.lastIndex = 0;
  for (let m = BLOCK_DELIMITER.exec(stripped); m; m = BLOCK_DELIMITER.exec(stripped)) {
    const at = m.index;
    const base = frames.length ? frames[frames.length - 1].paren : 0;
    switch (m[0]) {
      case "\n":
        line++;
        break;
      case "(":
        paren++;
        break;
      case ")":
        paren = Math.max(base, paren - 1);
        break;
      case ";":
        if (paren === base) headStart = at + 1;
        break;
      case "{": {
        const inParens = paren > base;
        const control = !inParens && CONTROL_HEAD.test(stripped.slice(headStart, at).trimStart());
        frames.push({ control, paren, resume: inParens ? headStart : -1 });
        headStart = at + 1;
        if (control && ++depth > worst.depth) {
          worst.depth = depth;
          worst.line = line;
        }
        break;
      }
      case "}": {
        const frame = frames.pop();
        headStart = frame && frame.resume !== -1 ? frame.resume : at + 1;
        if (!frame) break; // unbalanced source: a stray brace still ends a statement
        if (frame.control) depth--;
        paren = frame.paren;
        break;
      }
    }
  }
  return worst;
}

const INDENT_CONTROL = /^(?:if|elif|else|for|while|try|except|finally|match)\b.*:\s*$/;

// Indentation-delimited languages (Python, GDScript), on stripped source:
// a control header's body is every following line indented deeper than it.
export function indentNesting(stripped: string): Nesting {
  const open: number[] = []; // indents of the control headers enclosing the current line
  const worst: Nesting = { depth: 0, line: 0 };
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trimStart();
    if (!text) continue;
    const indent = lines[i].length - text.length;
    while (open.length && open[open.length - 1] >= indent) open.pop();
    if (!INDENT_CONTROL.test(text)) continue;
    open.push(indent);
    if (open.length > worst.depth) {
      worst.depth = open.length;
      worst.line = i + 1;
    }
  }
  return worst;
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
  // Deepest control-flow nesting — see braceNesting / indentNesting.
  nesting(source: string): Nesting;
  commentFacts(source: string): CommentFacts;
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

export type FunctionSpans =
  | { kind: "braces" }
  | { kind: "indent"; lines_inside_strings: ReadonlySet<number>; comment_columns: ReadonlyMap<number, number> };

export const BRACE_SPANS: FunctionSpans = { kind: "braces" };
export const INDENT_SPANS: FunctionSpans = { kind: "indent", lines_inside_strings: new Set(), comment_columns: new Map() };
type IndentSpans = Extract<FunctionSpans, { kind: "indent" }>;

const CONTINUES_SIGNATURE = /^\s*(?:[)\]>{=:,.|&]|where\b|->)/;
const CLOSES_BLOCK = /^\s*(?:\}|end\b)/;
const indentOf = (line: string) => line.length - line.trimStart().length;

function indentSpanEndLine(lines: string[], header: number, spans: IndentSpans): number {
  const headerIndent = indentOf(lines[header]);
  let lastInside = header;
  for (let ln = header + 1; ln < lines.length; ln++) {
    if (spans.lines_inside_strings.has(ln + 1)) continue;
    if (!lines[ln].trim()) {
      if ((spans.comment_columns.get(ln + 1) ?? -1) > headerIndent) lastInside = ln;
      continue;
    }
    const indent = indentOf(lines[ln]);
    if (indent > headerIndent || CONTINUES_SIGNATURE.test(lines[ln])) {
      lastInside = ln;
      continue;
    }
    const closesThisFunction = indent === headerIndent && CLOSES_BLOCK.test(lines[ln]);
    return (closesThisFunction ? ln : lastInside) + 1;
  }
  return lastInside + 1;
}

const OPEN_BRACE = "{", CLOSE_BRACE = "}", STATEMENT_END = ";", LIST_SEPARATOR = ",", LINE_BREAK = "\n";

function matchingBraces(stripped: string): Map<number, number> {
  const closes = new Map<number, number>();
  const open: number[] = [];
  for (let at = 0; at < stripped.length; at++) {
    const c = stripped[at];
    if (c === OPEN_BRACE) open.push(at);
    else if (c === CLOSE_BRACE && open.length) closes.set(open.pop()!, at);
  }
  return closes;
}

const OPENERS = new Set(["(", "["]);
const CLOSERS = new Set([")", "]"]);
const TYPE_LITERAL_FOLLOWS = new Set([":", "|", "&", "<"]);

function opensTypeLiteral(stripped: string, brace: number): boolean {
  let k = brace - 1;
  while (k >= 0 && /\s/.test(stripped[k])) k--;
  return TYPE_LITERAL_FOLLOWS.has(stripped[k]);
}

function blockBodyEnd(stripped: string, from: number, braces: Map<number, number>): number {
  let depth = 0;
  for (let at = from; at < stripped.length; at++) {
    const c = stripped[at];
    if (OPENERS.has(c)) depth++;
    else if (CLOSERS.has(c) && depth-- === 0) return at;
    else if (depth > 0) continue;
    else if (c === STATEMENT_END || c === CLOSE_BRACE) return at;
    else if (c === OPEN_BRACE) {
      const close = braces.get(at) ?? stripped.length;
      if (!opensTypeLiteral(stripped, at)) return close;
      at = close;
    }
  }
  return stripped.length;
}

function expressionBodyEnd(stripped: string, from: number): number {
  let depth = 0;
  let sawCode = false;
  for (let at = from; at < stripped.length; at++) {
    const c = stripped[at];
    if (c === LINE_BREAK && depth === 0 && sawCode) return at - 1;
    if (OPENERS.has(c) || c === OPEN_BRACE) depth++;
    else if ((CLOSERS.has(c) || c === CLOSE_BRACE) && depth-- === 0) return at;
    else if (depth === 0 && (c === STATEMENT_END || c === LIST_SEPARATOR)) return at;
    sawCode ||= c.trim() !== "";
  }
  return stripped.length;
}

interface SpanSource {
  stripped: string;
  lines: string[];
  lineStarts: number[];
  braces: Map<number, number> | null;
}

function nameEnd(header: RegExpExecArray): number {
  const group = header.slice(1).findIndex((g) => g !== undefined) + 1;
  const nameSpan = group > 0 ? header.indices?.[group] : undefined;
  return nameSpan ? nameSpan[1] : header.index + header[0].length;
}

const LESS_THAN = "<", GREATER_THAN = ">", ARROW_HEAD = "=";

function afterTypeParameters(stripped: string, from: number): number {
  let at = from;
  while (stripped[at] === " " || stripped[at] === "\t") at++;
  if (stripped[at] !== LESS_THAN) return from;
  let depth = 0;
  for (; at < stripped.length && stripped[at] !== LINE_BREAK; at++) {
    if (stripped[at] === LESS_THAN) depth++;
    else if (stripped[at] === GREATER_THAN && stripped[at - 1] !== ARROW_HEAD && --depth === 0) return at + 1;
  }
  return from;
}

function spanEndLine(source: SpanSource, spans: FunctionSpans, ln: number, header: RegExpExecArray, hasBody: boolean): number {
  if (spans.kind === "indent") return indentSpanEndLine(source.lines, ln, spans);
  source.braces ??= matchingBraces(source.stripped);
  const lineStart = source.lineStarts[ln];
  const end = hasBody
    ? blockBodyEnd(source.stripped, afterTypeParameters(source.stripped, lineStart + nameEnd(header)), source.braces)
    : expressionBodyEnd(source.stripped, lineStart + header.index + header[0].length);
  return Math.max(ln + 1, lineAt(source.lineStarts, Math.min(end, source.stripped.length - 1)));
}

function opensBlockBody(header: RegExpExecArray, line: string): boolean {
  const isArrowWithExpressionBody = /=>\s*$/.test(header[0]);
  return !isArrowWithExpressionBody || /^\s*\{/.test(line.slice(header.index + header[0].length));
}

const withMatchIndices = (pattern: RegExp) =>
  pattern.hasIndices ? pattern : new RegExp(pattern.source, pattern.flags + "d");

export function complexityFromMarkers(
  stripped: string,
  functionHeader: RegExp,
  decisionToken: RegExp,
  spans: FunctionSpans,
): ComplexityResult {
  const functions: FunctionComplexity[] = [];
  const hasBody: boolean[] = [];
  const lines = stripped.split("\n");
  const source: SpanSource = { stripped, lines, lineStarts: lineStartsOf(stripped), braces: null };
  const header = withMatchIndices(functionHeader);
  for (let ln = 0; ln < lines.length; ln++) {
    header.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = header.exec(lines[ln])) !== null) {
      const nameFromWhicheverAlternativeMatched = m.slice(1).find((g) => g !== undefined) ?? "<anonymous>";
      const bodied = opensBlockBody(m, lines[ln]);
      functions.push({
        name: nameFromWhicheverAlternativeMatched, complexity: 1, line: ln + 1,
        end_line: spanEndLine(source, spans, ln, m, bodied),
      });
      hasBody.push(bodied);
    }
  }
  let lastHeaderPassed = -1;
  let attributingFunction = -1;
  let moduleLevelDecisions = 0;
  for (let ln = 0; ln < lines.length; ln++) {
    while (lastHeaderPassed + 1 < functions.length && functions[lastHeaderPassed + 1].line === ln + 1) {
      lastHeaderPassed++;
      if (hasBody[lastHeaderPassed]) attributingFunction = lastHeaderPassed;
    }
    const onBodylessHeaderLine = lastHeaderPassed >= 0 && functions[lastHeaderPassed].line === ln + 1 && !hasBody[lastHeaderPassed];
    const target = onBodylessHeaderLine ? lastHeaderPassed : attributingFunction;
    const count = lines[ln].match(decisionToken)?.length ?? 0;
    if (target < 0) moduleLevelDecisions += count;
    else functions[target].complexity += count;
  }
  if (moduleLevelDecisions > 0) {
    functions.unshift({ name: "<module>", complexity: 1 + moduleLevelDecisions, line: 0, end_line: 0 });
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
