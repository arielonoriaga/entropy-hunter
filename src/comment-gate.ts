import type { LineChanges } from "./git";
import type { FunctionComplexity } from "./types";

interface Span {
  name: string;
  line: number;
  start: number;
  end: number;
}

function spansOf(functions: FunctionComplexity[], comments: Set<number>): Span[] {
  return functions
    .filter((f) => f.line > 0)
    .map((f) => {
      let start = f.line;
      while (comments.has(start - 1)) start--;
      return { name: f.name, line: f.line, start, end: Math.max(f.end_line, f.line) };
    })
    .sort((a, b) => a.start - b.start);
}

function innermostOwners(spans: Span[]): (line: number) => Span | null {
  const owner: (Span | null)[] = [];
  for (const span of spans) {
    for (let line = span.start; line <= span.end; line++) owner[line] = span;
  }
  return (line) => owner[line] ?? null;
}

function touchedSpans(spans: Span[], ownerOf: (line: number) => Span | null, changes: LineChanges): Set<Span> {
  if (changes.kind === "new-file") return new Set(spans);
  const touched = new Set<Span>();
  for (const line of changes.added) {
    const owner = ownerOf(line);
    if (owner) touched.add(owner);
  }
  for (const line of changes.removedAfter) {
    const owner = ownerOf(line);
    if (owner && owner === ownerOf(line + 1)) touched.add(owner);
  }
  return touched;
}

const plural = (count: number, word: string) => (count === 1 ? word : `${word}s`);
const MOVE_THE_WHY = "move the why into names/tests, then delete";

export function commentFindings(
  functions: FunctionComplexity[],
  commentLines: number[],
  changes: LineChanges,
): string[] {
  if (!commentLines.length) return [];
  const spans = spansOf(functions, new Set(commentLines));
  const ownerOf = innermostOwners(spans);
  const touched = touchedSpans(spans, ownerOf, changes);
  const carried = new Map<Span, number[]>();
  const loose: number[] = [];
  for (const line of commentLines) {
    const owner = ownerOf(line);
    if (owner && touched.has(owner)) carried.set(owner, [...(carried.get(owner) ?? []), line]);
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
