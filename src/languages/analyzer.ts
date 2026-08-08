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

// State-space exposure of one declared type: each optional/boolean field
// roughly doubles the representable states ("make illegal states
// unrepresentable" — sum types keep this at 0).
export interface TypeState {
  name: string;
  optional_fields: number;
  boolean_fields: number;
}

// Common interface every language plugin implements. The core engine only
// sees this — no language-specific AST leaks past this boundary.
export interface LanguageAnalyzer {
  language: string;
  detect(path: string): boolean;
  complexity(source: string): ComplexityResult;
  // fileSet: all repo-relative analyzed paths, for resolving internal deps.
  dependencies(source: string, path: string, fileSet: Set<string>): DependencyResult;
  // Lines eligible for duplication detection: normalized, trivia removed.
  normalizedLines(source: string): { line: number; text: string }[];
  // Declared data types and their optional/boolean field counts.
  stateSpace(source: string): TypeState[];
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
  const lines = stripped.split("\n");
  for (let ln = 0; ln < lines.length; ln++) {
    functionHeader.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = functionHeader.exec(lines[ln])) !== null) {
      // Multi-alternative regexes put the name in whichever group matched.
      const name = m.slice(1).find((g) => g !== undefined) ?? "<anonymous>";
      functions.push({ name, complexity: 1, line: ln + 1 });
    }
  }
  let fi = -1;
  let unattributed = 0;
  for (let ln = 0; ln < lines.length; ln++) {
    while (fi + 1 < functions.length && functions[fi + 1].line === ln + 1) fi++;
    const count = lines[ln].match(decisionToken)?.length ?? 0;
    if (fi < 0) unattributed += count;
    else functions[fi].complexity += count;
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

export function normalizedLinesFrom(stripped: string): { line: number; text: string }[] {
  const result: { line: number; text: string }[] = [];
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].replace(/\s+/g, " ").trim();
    // Skip blanks and structural noise (lone braces/brackets) — they
    // duplicate everywhere without meaning anything.
    if (t.length < 3 || /^[{}()\[\];,]+$/.test(t)) continue;
    result.push({ line: i + 1, text: t });
  }
  return result;
}
