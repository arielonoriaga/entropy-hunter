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
const LINT_RULE = String.raw`[@\w][\w@/.-]*`;
const LINT_RULES = String.raw`(?:\s+${LINT_RULE}(?:\s*,\s*${LINT_RULE})*)?`;
const LINT_DIRECTIVE = "(?:disable(?:-next-line|-line)?|enable)";
const WEBPACK_HINT = String.raw`webpack(?:ChunkName|Prefetch|Preload|Mode|Ignore|Exports|Include|Exclude|FetchPriority)\s*:\s*(?:"[^"]*"|'[^']*'|true|false|-?\d+)`;
const PRAGMA_GRAMMARS = [
  "eslint-" + LINT_DIRECTIVE + LINT_RULES,
  "oxlint-" + LINT_DIRECTIVE + LINT_RULES,
  "tslint:(?:disable|enable)(?:-next-line|-line)?(?::[\\w-]+(?:\\s+[\\w-]+)*)?",
  "@ts-(?:ignore|expect-error|nocheck|check)",
  "prettier-ignore",
  "biome-ignore(?:-all|-start|-end)?(?:\\s+[\\w/-]+:?)?",
  "NOLINT(?:NEXTLINE|BEGIN|END)?(?:\\([\\w.,*-]+\\))?",
  "(?:noqa|NOQA)(?::\\s*[A-Z]+\\d+(?:\\s*,\\s*[A-Z]+\\d+)*)?",
  "type:\\s*ignore(?:\\[[\\w-]+(?:\\s*,\\s*[\\w-]+)*\\])?",
  "istanbul\\s+ignore\\s+(?:next|if|else|file)",
  "(?:c8|v8)\\s+ignore\\s+(?:next(?:\\s+\\d+)?|start|stop|file)",
  "pylint:\\s*(?:(?:disable|enable|disable-next)=[\\w-]+(?:\\s*,\\s*[\\w-]+)*|skip-file)",
  "shellcheck(?:\\s+(?:disable|enable|source|source-path|shell|external-sources)=\\S+)+",
  "rustfmt::skip",
  "<reference\\s+(?:path|types|lib)=\"[^\"]*\"\\s*\\/>",
  WEBPACK_HINT + "(?:\\s*,\\s*" + WEBPACK_HINT + ")*",
  "@vite-ignore",
];
const TOOL_PRAGMA = new RegExp(`^(?:${PRAGMA_GRAMMARS.join("|")})$`);
const STAR = 42;
const LICENSE_LINE =
  /^(?:SPDX-License-Identifier:\s*[\w.+-]+(?:\s+(?:AND|OR|WITH)\s+[\w.+-]+)*|@license(?:\s+[\w.+-]+)?|Copyright\s+(?:\(c\)\s*|©\s*)?\d{4}\b.*)$/i;
const DECORATOR = /^\s*(?:@[A-Za-z_$][\w$.]*(?:\(.*\))?|#!?\[.*\])\s*$/;
const DECORATOR_START = /^\s*(?:@[A-Za-z_$]|#!?\[)/;
const MAX_DECORATOR_LINES = 64;

interface Source {
  text: string;
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

function reportedLinesOf(source: Source, region: Region, licensed: Set<number>): number[] {
  const lines = linesOf(source, region).map((line) => ({ line, body: bodyOnLine(source, region, line) }));
  const exempt = ({ line, body }: { line: number; body: string }) =>
    licensed.has(line) || (isShebang(source, line) && region.from === 0) || TOOL_PRAGMA.test(body);
  const withText = lines.filter(({ body }) => body !== "");
  const regionSaysSomething = withText.length === 0 || withText.some((entry) => !exempt(entry));
  return lines
    .filter((entry) => (entry.body === "" ? regionSaysSomething : !exempt(entry)))
    .map(({ line }) => line);
}

export function commentFactsOf(text: string, dialect: Dialect): CommentFacts {
  const regions: Region[] = [];
  const stripped = stripCommentsAndStrings(text, dialect, "blank-strings", (from, to, kind) => {
    if (kind === "comment") regions.push({ from, to });
  });
  if (!regions.length) return NO_COMMENTS;
  const source: Source = { text, lineStarts: lineStartsOf(text), strippedLines: stripped.split("\n") };
  const licensed = leadingLicenseLines(source, regions);
  const reported = new Set<number>();
  const covered = new Set<number>();
  for (const region of regions) {
    linesOf(source, region).forEach((line) => covered.add(line));
    reportedLinesOf(source, region, licensed).forEach((line) => reported.add(line));
  }
  const commentOnly = [...covered].filter((line) => source.strippedLines[line - 1].trim() === "");
  const decorators = decoratorLines(source.strippedLines);
  const ascending = (a: number, b: number) => a - b;
  return {
    lines: [...reported].sort(ascending),
    lead_in_lines: [...new Set([...commentOnly, ...decorators])].sort(ascending),
  };
}
