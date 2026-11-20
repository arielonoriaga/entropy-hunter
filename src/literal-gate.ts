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

interface SourceLiteral {
  from: number;
  to: number;
  open: number;
  end: number;
  value: string;
}

function sourceLiterals(source: string, dialect: Dialect): { code: string; literals: SourceLiteral[] } {
  const literals: SourceLiteral[] = [];
  const code = stripCommentsAndStrings(source, dialect, "blank-strings", (from, to, kind) => {
    if (kind === STRING_REGION) {
      literals.push({ from, to, open: from - 1, end: to + 1, value: source.slice(from, to) });
      return;
    }
    if (kind !== OPAQUE_REGION || dialect !== RUST_DIALECT) return;
    const raw = /^r(#*)"/.exec(source.slice(from, to));
    if (!raw) return;
    const start = from + raw[0].length;
    const stop = to - raw[1].length - 1;
    literals.push({ from: start, to: stop, open: from, end: to, value: source.slice(start, stop) });
  });
  return { code, literals };
}

const TYPE_TAGS = new Set(["undefined", "object", "boolean", "number", "bigint", "string", "symbol", "function"]);
const COMPARISON_BEFORE = /(?:===?|!==?)\s*$/;
const COMPARISON_AFTER = /^\s*(?:===?|!==?)/;
const TYPEOF_BEFORE = /\btypeof\s+[A-Za-z_$][\w$]*(?:\s*(?:\.|\?\.)\s*[A-Za-z_$][\w$]*)*\s*(?:===?|!==?)\s*$/;
const TYPEOF_AFTER = /^\s*(?:===?|!==?)\s*typeof\b/;

function isStringComparison(before: string, after: string, value: string, dialect: Dialect): boolean {
  const comparison = COMPARISON_BEFORE.test(before) || COMPARISON_AFTER.test(after);
  const caseLabel = /\bcase\s*$/.test(before) && /^\s*:/.test(after);
  if (!comparison) return caseLabel;
  const typeTag = dialect !== RUST_DIALECT && TYPE_TAGS.has(value);
  return !(typeTag && (TYPEOF_BEFORE.test(before) || TYPEOF_AFTER.test(after)));
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

function sqlHits(literal: SourceLiteral): LiteralHit[] {
  if (!/\b(?:SELECT|FROM|WHERE|UPDATE|SET|VALUES|JOIN|ON|WHEN|CASE|IN)\b/i.test(literal.value)) return [];
  const hits: LiteralHit[] = [];
  const collect = (text: string, offset: number, pattern: RegExp) => {
    for (const match of text.matchAll(pattern)) {
      const at = match.index + match[0].indexOf("'") + 1;
      hits.push({ kind: LiteralKind.SqlDiscriminant, value: match[1], offset: offset + at });
    }
  };
  collect(literal.value, literal.from, /(?:=|<>|!=)\s*'([a-z][a-z0-9_]+)'/g);
  for (const list of literal.value.matchAll(/\b(?:VALUES|IN)\s*\(([^)]*)\)/gi)) {
    const offset = literal.from + list.index + list[0].indexOf("(") + 1;
    collect(list[1], offset, /'([a-z][a-z0-9_]+)'/g);
  }
  return hits;
}

function literalHits(literal: SourceLiteral, code: string, dialect: Dialect): LiteralHit[] {
  const hits = sqlHits(literal);
  const before = code.slice(0, literal.open);
  const after = code.slice(literal.end);
  if (dialect === RUST_DIALECT && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(literal.value) && !isErrorCodeHome(before)) {
    hits.push({ kind: LiteralKind.ErrorCode, value: literal.value, offset: literal.from });
  }
  if (literal.value && isStringComparison(before, after, literal.value, dialect)) {
    hits.push({ kind: LiteralKind.StringComparison, value: literal.value, offset: literal.from });
  }
  return hits;
}

export function literalFindings(path: string, source: string, changes: LineChanges): string[] {
  const dialect = dialectOf(path);
  if (!dialect) return [];
  const { code, literals } = sourceLiterals(source, dialect);
  const starts = lineStartsOf(source);
  return literals.flatMap(literal => literalHits(literal, code, dialect))
    .sort((a, b) => a.offset - b.offset)
    .flatMap(hit => {
      const line = lineAt(starts, hit.offset);
      if (changes.kind !== NEW_FILE && !changes.added.has(line)) return [];
      return ['line ' + line + ': ' + LABEL[hit.kind] + ' "' + hit.value + '" as a hardcoded string — ' + ADVICE[hit.kind]];
    });
}
