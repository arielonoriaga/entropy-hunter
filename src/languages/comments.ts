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
const PRAGMA_WORDS = [
  "eslint-disable(?:-next-line|-line)?", "eslint-enable",
  "tslint:(?:disable|enable)(?:-next-line|-line)?", "oxlint-(?:disable|enable)(?:-next-line|-line)?",
  "@ts-(?:ignore|expect-error|nocheck|check)", "prettier-ignore", "biome-ignore",
  "NOLINT(?:NEXTLINE|BEGIN|END)?", "noqa", "type:\\s*ignore", "(?:istanbul|c8|v8) ignore",
  "pylint:\\s*disable", "rubocop:(?:disable|enable)", "rustfmt::skip", "@vite-ignore",
];
const PRAGMA_PREFIXES = [
  "shellcheck\\s+(?:disable|source|shell)=", "clippy::", "<reference\\s",
  "webpack(?:ChunkName|Prefetch|Preload|Mode|Ignore|Exports|Include|Exclude|FetchPriority)\\s*:",
];
const TOOL_PRAGMA = new RegExp(`^(?:(?:${PRAGMA_WORDS.join("|")})(?=$|[\\s:=,(\\[])|${PRAGMA_PREFIXES.join("|")})`);
const STAR = 42;
const LICENSE = /^(?:SPDX-License-Identifier:|@license\b|Copyright\s+(?:\(c\)\s*|©\s*)?\d{4})/i;
const DECORATOR_LINE = /^\s*(?:@[A-Za-z_$][\w$.]*(?:\(.*\))?|#!?\[.*\])\s*$/;

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
  let run: number[] = [];
  let runIsLicense = false;
  const closeRun = () => {
    if (runIsLicense) run.forEach((line) => licensed.add(line));
    run = [];
    runIsLicense = false;
  };
  for (const region of regions) {
    for (const line of linesOf(source, region)) {
      if (line >= beforeCode) break;
      if (run.length && line > run[run.length - 1] + 1) closeRun();
      if (run[run.length - 1] !== line) run.push(line);
      runIsLicense ||= LICENSE.test(bodyOnLine(source, region, line));
    }
  }
  closeRun();
  return licensed;
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
  const decorators = source.strippedLines.flatMap((line, k) => (DECORATOR_LINE.test(line) ? [k + 1] : []));
  const ascending = (a: number, b: number) => a - b;
  return {
    lines: [...reported].sort(ascending),
    lead_in_lines: [...new Set([...commentOnly, ...decorators])].sort(ascending),
  };
}
