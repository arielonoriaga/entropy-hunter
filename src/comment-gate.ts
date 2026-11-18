import type { LineChanges } from "./git";
import type { CommentFacts } from "./languages/comments";
import type { FunctionComplexity } from "./types";

interface Span {
  name: string;
  line: number;
  start: number;
  end: number;
}

function spansOf(functions: FunctionComplexity[], leadIn: Set<number>): Span[] {
  return functions
    .filter((f) => f.line > 0)
    .map((f) => {
      let start = f.line;
      while (leadIn.has(start - 1)) start--;
      return { name: f.name, line: f.line, start, end: Math.max(f.end_line, f.line) };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);
}

function innermostOwners(spans: Span[]): (line: number) => Span | null {
  const owner: (Span | null)[] = [];
  for (const span of spans) {
    for (let line = span.start; line <= span.end; line++) owner[line] = span;
  }
  return (line) => owner[line] ?? null;
}

const indentWidth = (text: string | undefined) => (text ?? "").length - (text ?? "").trimStart().length;

function spanHoldingRemoval(spans: Span[], ownerOf: (line: number) => Span | null, line: number, removedIndent: number, sourceLines: string[]): Span | null {
  const owner = ownerOf(line);
  if (owner && owner === ownerOf(line + 1)) return owner;
  const holders = spans.filter((span) => span.line <= line && line <= span.end && indentWidth(sourceLines[span.line - 1]) < removedIndent);
  return holders.reduce<Span | null>((inner, span) => (!inner || span.line > inner.line ? span : inner), null);
}

function touchedSpans(spans: Span[], ownerOf: (line: number) => Span | null, changes: LineChanges, sourceLines: string[]): Set<Span> {
  if (changes.kind === "new-file") return new Set(spans);
  const touched = new Set<Span>();
  for (const line of changes.added) {
    const owner = ownerOf(line);
    if (owner) touched.add(owner);
  }
  for (const [line, removedIndent] of changes.removedAfter) {
    const holder = spanHoldingRemoval(spans, ownerOf, line, removedIndent, sourceLines);
    if (holder) touched.add(holder);
  }
  return touched;
}

const plural = (count: number, word: string) => (count === 1 ? word : `${word}s`);
const MOVE_THE_WHY = "move the why into names/tests, then delete";

export function commentFindings(functions: FunctionComplexity[], comments: CommentFacts, changes: LineChanges, source: string): string[] {
  if (!comments.lines.length) return [];
  const spans = spansOf(functions, new Set(comments.lead_in_lines));
  const ownerOf = innermostOwners(spans);
  const touched = touchedSpans(spans, ownerOf, changes, source.split("\n"));
  const carried = new Map<Span, number[]>();
  const loose: number[] = [];
  for (const line of comments.lines) {
    const owner = ownerOf(line);
    if (owner && touched.has(owner)) {
      const lines = carried.get(owner);
      if (lines) lines.push(line);
      else carried.set(owner, [line]);
    }
    else if (!owner && (changes.kind === "new-file" || changes.added.has(line))) loose.push(line);
  }
  const inFunctions = [...carried].map(
    ([span, lines]) =>
      `function \`${span.name}\` (line ${span.line}) still carries ${lines.length} ${plural(lines.length, "comment")} (${plural(lines.length, "line")} ${lines.join(", ")}) — ${MOVE_THE_WHY} ${lines.length === 1 ? "it" : "them"}`,
  );
  const outside = loose.length
    ? [`new ${plural(loose.length, "comment")} outside any function at ${plural(loose.length, "line")} ${loose.join(", ")} — ${MOVE_THE_WHY} ${loose.length === 1 ? "it" : "them"}`]
    : [];
  return [...inFunctions, ...outside];
}
