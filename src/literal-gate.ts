import type { LineChanges } from "./git";
import { stripCommentsAndStrings, type Dialect } from "./languages/strip";

export const LiteralKind = {
  ErrorCode: "error-code",
  SqlDiscriminant: "sql-discriminant",
  StringComparison: "string-comparison",
} as const;
export type LiteralKind = (typeof LiteralKind)[keyof typeof LiteralKind];

interface LiteralRule {
  kind: LiteralKind;
  dialects: ReadonlySet<Dialect>;
  pattern: RegExp;
  allowedOn?: RegExp;
  requiredOn?: RegExp;
}

const SQL_KEYWORD = /\b(?:SELECT|FROM|WHERE|AND|OR|SET|VALUES|JOIN|ON|WHEN|CASE|IN|NOT|THEN|ELSE)\b/;
const SQL_LIST = /\b(?:VALUES|IN)\s*\(/;

const RUST = new Set<Dialect>(["rust"]);
const RUST_AND_JS = new Set<Dialect>(["rust", "javascript", "jsx"]);

const RULES: LiteralRule[] = [
  {
    kind: LiteralKind.ErrorCode,
    dialects: RUST,
    pattern: /"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)"/g,
    allowedOn: /=>\s*"[A-Z]|#\[\s*serde|^\s*(?:pub\s+)?const\s/,
  },
  {
    kind: LiteralKind.SqlDiscriminant,
    dialects: RUST_AND_JS,
    pattern: /(?:=|<>|!=)\s*'([a-z][a-z0-9_]+)'/g,
    requiredOn: SQL_KEYWORD,
  },
  {
    kind: LiteralKind.SqlDiscriminant,
    dialects: RUST_AND_JS,
    pattern: /[(,]\s*'([a-z][a-z0-9_]+)'\s*(?=[,)])/g,
    requiredOn: SQL_LIST,
  },
  {
    kind: LiteralKind.StringComparison,
    dialects: RUST_AND_JS,
    pattern: /(?:===?|!==?)\s*["'`]([^"'`\n]+)["'`]|["'`]([^"'`\n]+)["'`]\s*(?:===?|!==?)|\bcase\s+["'`]([^"'`\n]+)["'`]\s*:/g,
    allowedOn: /\btypeof\b/,
  },
];

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

const touchedLines = (changes: LineChanges, total: number): number[] =>
  changes.kind === "new-file" ? Array.from({ length: total }, (_, i) => i + 1) : [...changes.added].sort((a, b) => a - b);

export function literalFindings(path: string, source: string, changes: LineChanges): string[] {
  const dialect = dialectOf(path);
  if (!dialect) return [];
  const lines = stripCommentsAndStrings(source, dialect, "keep-strings").split("\n");
  const findings: string[] = [];
  for (const lineNo of touchedLines(changes, lines.length)) {
    const text = lines[lineNo - 1] ?? "";
    for (const rule of RULES) {
      if (!rule.dialects.has(dialect) || rule.allowedOn?.test(text)) continue;
      if (rule.requiredOn && !rule.requiredOn.test(text)) continue;
      for (const match of text.matchAll(rule.pattern)) {
        const literal = match.slice(1).find((g) => g !== undefined) ?? match[0];
        findings.push(`line ${lineNo}: ${LABEL[rule.kind]} "${literal}" as a hardcoded string — ${ADVICE[rule.kind]}`);
      }
    }
  }
  return findings;
}
