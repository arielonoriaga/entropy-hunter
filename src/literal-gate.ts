import { javascriptLiterals, type LiteralText } from "./literal-javascript";
import type { LineChanges } from "./git";
import { stripCommentsAndStrings, lineStartsOf, lineAt, type Dialect } from "./languages/strip";

export const LiteralKind = {
  ErrorCode: "error-code",
  SqlDiscriminant: "sql-discriminant",
  StringComparison: "string-comparison",
} as const;
export type LiteralKind = (typeof LiteralKind)[keyof typeof LiteralKind];

const ADVICE: Record<LiteralKind, string> = {
  [LiteralKind.ErrorCode]: "name it with an enum variant whose code() match is the one place the text lives",
  [LiteralKind.SqlDiscriminant]: "bind the enum's value (e.g. `Kind::Variant.as_str()`) instead of writing it into the query",
  [LiteralKind.StringComparison]: "compare against an enum / const-object member, not an inline string",
};

const LABEL: Record<LiteralKind, string> = {
  [LiteralKind.ErrorCode]: "error code",
  [LiteralKind.SqlDiscriminant]: "SQL discriminant",
  [LiteralKind.StringComparison]: "string comparison with",
};

export function dialectOf(path: string): Dialect | null {
  if (path.endsWith(".rs")) return "rust";
  if (/\.[jt]sx$/.test(path)) return "jsx";
  if (/\.[cm]?[jt]s$/.test(path)) return "javascript";
  return null;
}

const RUST_DIALECT = "rust";
const STRING_REGION = "string";
const OPAQUE_REGION = "opaque";
const NEW_FILE = "new-file";

interface SourceLiteral extends LiteralText {
  open: number;
  end: number;
}

function sourceLiterals(source: string): { code: string; literals: SourceLiteral[] } {
  const literals: SourceLiteral[] = [];
  const code = stripCommentsAndStrings(source, RUST_DIALECT, "blank-strings", (from, to, kind) => {
    if (kind === STRING_REGION) {
      literals.push({ from, open: from - 1, end: to + 1, value: source.slice(from, to) });
      return;
    }
    if (kind !== OPAQUE_REGION) return;
    const raw = /^r(#*)"/.exec(source.slice(from, to));
    if (!raw) return;
    const start = from + raw[0].length;
    const stop = to - raw[1].length - 1;
    literals.push({ from: start, open: from, end: to, value: source.slice(start, stop) });
  });
  return { code, literals };
}

function isStringComparison(before: string, after: string): boolean {
  return /(?:===?|!==?)\s*$/.test(before) || /^\s*(?:===?|!==?)/.test(after);
}

function isErrorCodeHome(before: string): boolean {
  return /=>\s*$/.test(before)
    || /#\[\s*serde\b[^\]]*$/.test(before)
    || /\bconst\s+\w+\s*:[^;={}]+=\s*$/.test(before);
}

interface LiteralHit {
  kind: LiteralKind;
  value: string;
  offset: number;
}

function sqlHits(literal: LiteralText): LiteralHit[] {
  if (!/\b(?:SELECT|FROM|WHERE|UPDATE|SET|VALUES|JOIN|ON|WHEN|CASE|IN)\b/i.test(literal.value)) return [];
  const hits: LiteralHit[] = [];
  const collect = (text: string, offset: number, pattern: RegExp) => {
    for (const match of text.matchAll(pattern)) {
      const at = match.index + match[0].indexOf("'") + 1;
      hits.push({ kind: LiteralKind.SqlDiscriminant, value: match[1], offset: offset + at });
    }
  };
  collect(literal.value, literal.from, /(?:=|<>|!=)\s*\\?'([a-z][a-z0-9_]+)\\?'/g);
  for (const list of literal.value.matchAll(/\b(?:VALUES|IN)\s*\(([^)]*)\)/gi)) {
    const offset = literal.from + list.index + list[0].indexOf("(") + 1;
    collect(list[1], offset, /\\?'([a-z][a-z0-9_]+)\\?'/g);
  }
  return hits;
}

function literalHits(literal: SourceLiteral, code: string): LiteralHit[] {
  const hits = sqlHits(literal);
  const before = code.slice(0, literal.open);
  const after = code.slice(literal.end);
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(literal.value) && !isErrorCodeHome(before)) {
    hits.push({ kind: LiteralKind.ErrorCode, value: literal.value, offset: literal.from });
  }
  if (literal.value && isStringComparison(before, after)) {
    hits.push({ kind: LiteralKind.StringComparison, value: literal.value, offset: literal.from });
  }
  return hits;
}

function sourceHits(path: string, source: string, dialect: Dialect): LiteralHit[] {
  if (dialect === RUST_DIALECT) {
    const { code, literals } = sourceLiterals(source);
    return literals.flatMap(literal => literalHits(literal, code));
  }
  const { comparisons, sql } = javascriptLiterals(path, source);
  return [
    ...comparisons.map(literal => ({ kind: LiteralKind.StringComparison, value: literal.value, offset: literal.from })),
    ...sql.flatMap(sqlHits),
  ];
}

export function literalFindings(path: string, source: string, changes: LineChanges): string[] {
  const dialect = dialectOf(path);
  if (!dialect) return [];
  const starts = lineStartsOf(source);
  return sourceHits(path, source, dialect)
    .sort((a, b) => a.offset - b.offset)
    .flatMap(hit => {
      const line = lineAt(starts, hit.offset);
      if (changes.kind !== NEW_FILE && !changes.added.has(line)) return [];
      return ['line ' + line + ': ' + LABEL[hit.kind] + ' "' + hit.value + '" as a hardcoded string — ' + ADVICE[hit.kind]];
    });
}
