import { lineAt, lineStartsOf, stripCommentsAndStrings, type Dialect } from "./strip";

export interface CommentFacts {
  lines: number[];
  lead_in_lines: number[];
}

export const NO_COMMENTS: CommentFacts = { lines: [], lead_in_lines: [] };

interface Region {
  from: number;
  to: number;
}

const LEADING_COMMENT_MARKER = /^\s*(?:\/\/[/!]?|\/\*+!?|\*+(?!\/)|#+!?)?\s*/;
const WORD_END = String.raw`(?![\w-])`;
const ENDS_IN_PUNCTUATION = /[:=$]$/;
const directives = (...forms: string[]) => forms.map((form) => (ENDS_IN_PUNCTUATION.test(form) ? form : form + WORD_END));
const EVERY_LANGUAGE = directives(
  "NOLINT(?:NEXTLINE|BEGIN|END)?",
  "prettier-ignore",
  "@formatter:(?:on|off)",
  "(?:cspell|spell-checker|codespell):",
  "(?:cspell|spell-checker)-(?:disable|enable)(?:-next-line|-line)?",
  "gitleaks:allow",
  "nosemgrep",
  "NOSONAR",
  "noinspection",
  "language=",
  "vim?:",
);
const JAVASCRIPT = directives(
  "eslint-[a-z-]+",
  String.raw`eslint\s+[@\w/-]+\s*:`,
  String.raw`globals?\s+[A-Za-z_$][\w$]*(?:\s*:\s*\w+)?(?:\s*,\s*[A-Za-z_$][\w$]*(?:\s*:\s*\w+)?)*\s*$`,
  "(?:oxlint|stylelint)-(?:disable|enable)[a-z-]*",
  "tslint:(?:disable|enable)",
  "jshint",
  "@ts-(?:ignore|expect-error|nocheck|check)",
  "biome-ignore(?:-all|-start|-end)?",
  "deno-(?:lint|fmt)-ignore(?:-file)?",
  String.raw`(?:istanbul|c8|v8)\s+ignore`,
  String.raw`node:coverage\s+(?:ignore|disable|enable)`,
  "@vite-ignore",
  "(?:webpack|turbopack)[A-Z]\\w*\\s*:",
  "[#@]__(?:PURE|NO_SIDE_EFFECTS|INLINE|KEY)__",
  "@jsx(?:Frag|ImportSource|Runtime)?",
  "<(?:reference|amd-module|amd-dependency)",
  "@(?:no)?flow",
  "\\$Flow(?:FixMe|Ignore|ExpectedError|Issue)",
  "[#@]\\s*source(?:MappingURL|URL)=",
  "@refresh",
  "@deprecated",
  "@(?:vitest|jest)-environment",
  "#(?:end)?region",
  "svelte-ignore",
);
const PYTHON = directives(
  "(?:noqa|NOQA)",
  "nosec",
  "(?:type|pyright|mypy|pylint|pragma|fmt|isort|ruff|pytype|flake8|yapf|autopep8)\\s*:",
  "pyre-(?:ignore|fixme|strict|unsafe)",
);
const RUST = directives("SAFETY:", "rustfmt::skip");
const SHELL = directives("shellcheck");
const directiveMatcher = (forms: string[]) => new RegExp(`^(?:${[...EVERY_LANGUAGE, ...forms].join("|")})`);
const TOOL_DIRECTIVE = new Map<Dialect, RegExp>([
  ["javascript", directiveMatcher(JAVASCRIPT)],
  ["jsx", directiveMatcher(JAVASCRIPT)],
  ["python", directiveMatcher(PYTHON)],
  ["hash", directiveMatcher(PYTHON)],
  ["rust", directiveMatcher(RUST)],
  ["shell", directiveMatcher(SHELL)],
]);
const ONLY_SHARED_DIRECTIVES = directiveMatcher([]);
const ENCODING_DECLARATION = /^.*?coding[:=]\s*[-\w.]+/;
const LAST_ENCODING_LINE = 2;
const DECLARES_ENCODING = new Set<Dialect>(["python", "hash"]);
const STAR = 42;
const LICENSE_LINE =
  /^(?:SPDX-License-Identifier:\s*[\w.+-]+(?:\s+(?:AND|OR|WITH)\s+[\w.+-]+)*|@license(?:\s+[\w.+-]+)?|Copyright\s+(?:\(c\)\s*|©\s*)?\d{4}\b.*)$/i;
const DECORATOR = /^\s*(?:@[A-Za-z_$][\w$.]*(?:\(.*\))?|#!?\[.*\])\s*$/;
const DECORATOR_START = /^\s*(?:@[A-Za-z_$]|#!?\[)/;
const MAX_DECORATOR_LINES = 64;

interface Source {
  text: string;
  directive: RegExp;
  declaresEncoding: boolean;
  lineStarts: number[];
  strippedLines: string[];
}

function lineText(source: Source, line: number): string {
  const start = source.lineStarts[line - 1];
  const next = source.lineStarts[line];
  return source.text.slice(start, next === undefined ? source.text.length : next - 1);
}

function withoutBlockClose(body: string): string {
  if (!body.endsWith("*/")) return body;
  let end = body.length - 2;
  while (end > 0 && body.charCodeAt(end - 1) === STAR) end--;
  return body.slice(0, end);
}

function bodyOnLine(source: Source, region: Region, line: number): string {
  const start = source.lineStarts[line - 1];
  const text = lineText(source, line);
  const from = Math.max(region.from - start, 0);
  const to = Math.min(region.to - start, text.length);
  return withoutBlockClose(text.slice(from, to).replace(LEADING_COMMENT_MARKER, "").trimEnd()).trim();
}

function linesOf(source: Source, region: Region): number[] {
  const first = lineAt(source.lineStarts, region.from);
  const last = lineAt(source.lineStarts, region.to - 1);
  return Array.from({ length: last - first + 1 }, (_, k) => first + k);
}

const isShebang = (source: Source, line: number) => line === 1 && source.text.startsWith("#!");

function firstCodeLine(source: Source): number {
  const index = source.strippedLines.findIndex((text, k) => text.trim() !== "" && !(k === 0 && isShebang(source, 1)));
  return index === -1 ? source.strippedLines.length + 1 : index + 1;
}

const RUST_DOC_LINE = /^\s*\/\/[\/!]/;
const CLIPPY_DOC_SECTION = /^\s*\/\/[\/!]\s*#\s+(?:Errors|Panics|Safety)\b/;

function clippyRequiredDocBlockLines(source: Source, dialect: Dialect): number[] {
  if (dialect !== "rust") return [];
  const lines = source.text.split("\n");
  const required: number[] = [];
  for (let start = 0; start < lines.length; start++) {
    if (!RUST_DOC_LINE.test(lines[start])) continue;
    let end = start;
    while (end + 1 < lines.length && RUST_DOC_LINE.test(lines[end + 1])) end++;
    if (lines.slice(start, end + 1).some((line) => CLIPPY_DOC_SECTION.test(line))) {
      for (let line = start; line <= end; line++) required.push(line + 1);
    }
    start = end;
  }
  return required;
}

function leadingLicenseLines(source: Source, regions: Region[]): Set<number> {
  const beforeCode = firstCodeLine(source);
  const licensed = new Set<number>();
  for (const region of regions) {
    for (const line of linesOf(source, region)) {
      if (line >= beforeCode) return licensed;
      if (LICENSE_LINE.test(bodyOnLine(source, region, line))) licensed.add(line);
    }
  }
  return licensed;
}

const BRACKET_DEPTH_CHANGE = new Map([["(", 1], ["[", 1], ["{", 1], [")", -1], ["]", -1], ["}", -1]]);

function bracketDelta(line: string): number {
  let delta = 0;
  for (const c of line) delta += BRACKET_DEPTH_CHANGE.get(c) ?? 0;
  return delta;
}

function decoratorLines(strippedLines: string[]): number[] {
  const found: number[] = [];
  for (let first = 0; first < strippedLines.length; first++) {
    if (!DECORATOR_START.test(strippedLines[first])) continue;
    let last = first;
    let depth = bracketDelta(strippedLines[first]);
    while (depth > 0 && last + 1 < strippedLines.length && last - first < MAX_DECORATOR_LINES) {
      depth += bracketDelta(strippedLines[++last]);
    }
    const joined = strippedLines.slice(first, last + 1).map((line) => line.trim()).join(" ");
    if (!DECORATOR.test(joined)) continue;
    for (let line = first; line <= last; line++) found.push(line + 1);
    first = last;
  }
  return found;
}

function reportedLinesOf(source: Source, region: Region, exemptBlocks: Set<number>): number[] {
  const lines = linesOf(source, region).map((line) => ({ line, body: bodyOnLine(source, region, line) }));
  const exempt = ({ line, body }: { line: number; body: string }) =>
    exemptBlocks.has(line) ||
    (isShebang(source, line) && region.from === 0) ||
    source.directive.test(body) ||
    (source.declaresEncoding && line <= LAST_ENCODING_LINE && ENCODING_DECLARATION.test(body));
  const withText = lines.filter(({ body }) => body !== "");
  const regionSaysSomething = withText.length === 0 || withText.some((entry) => !exempt(entry));
  return lines
    .filter((entry) => !exemptBlocks.has(entry.line))
    .filter((entry) => (entry.body === "" ? regionSaysSomething : !exempt(entry)))
    .map(({ line }) => line);
}

export function commentFactsOf(text: string, dialect: Dialect): CommentFacts {
  const regions: Region[] = [];
  const stripped = stripCommentsAndStrings(text, dialect, "blank-strings", (from, to, kind) => {
    if (kind === "comment") regions.push({ from, to });
  });
  if (!regions.length) return NO_COMMENTS;
  const source: Source = {
    text,
    directive: TOOL_DIRECTIVE.get(dialect) ?? ONLY_SHARED_DIRECTIVES,
    declaresEncoding: DECLARES_ENCODING.has(dialect),
    lineStarts: lineStartsOf(text),
    strippedLines: stripped.split("\n"),
  };
  const exemptBlocks = new Set([...leadingLicenseLines(source, regions), ...clippyRequiredDocBlockLines(source, dialect)]);
  const reported = new Set<number>();
  const covered = new Set<number>();
  for (const region of regions) {
    linesOf(source, region).forEach((line) => covered.add(line));
    reportedLinesOf(source, region, exemptBlocks).forEach((line) => reported.add(line));
  }
  const commentOnly = [...covered].filter((line) => source.strippedLines[line - 1].trim() === "");
  const decorators = decoratorLines(source.strippedLines);
  const ascending = (a: number, b: number) => a - b;
  return {
    lines: [...reported].sort(ascending),
    lead_in_lines: [...new Set([...commentOnly, ...decorators])].sort(ascending),
  };
}
