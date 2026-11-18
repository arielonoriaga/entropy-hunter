// Replace comments and string contents with spaces, preserving line structure
// so token counts and line numbers stay meaningful. Deterministic single pass.
// ponytail: handles //, /* */, "", '', ``, and Rust r"..."/r#"..."# — not
// nested template-literal expressions or nested block comments; good enough
// for counting decision tokens.
// Hot path of a cold run (every file is stripped at least once), so it works
// on char codes and whole slices: untouched runs are copied verbatim in one
// slice and blanked regions in one regex replace, instead of one array push
// per character.
const SLASH = 47, STAR = 42, HASH = 35, LOWER_R = 114, NEWLINE = 10;
const DOUBLE = 34, SINGLE = 39, BACKTICK = 96, BACKSLASH = 92;
const OPEN_BRACKET = 91, CLOSE_BRACKET = 93;
const LESS = 60, GREATER = 62, EQUALS = 61, OPEN_BRACE = 123, CLOSE_BRACE = 125;
const RAW_STRING_OPEN = new RegExp('r(#*)"', "y");

// A `/` starts a regex literal (rather than dividing) when what precedes it
// cannot end an expression: an operator/opening punctuator, or a keyword.
// `<` and `>` are deliberately absent so JSX closing tags are left alone.
const BEFORE_REGEX = new Set("(,=:[!&|?{;+-*%~^".split("").map((c) => c.charCodeAt(0)));
const KEYWORD_BEFORE_REGEX = /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw|new|do|else|yield|await)$/;
const MAX_KEYWORD_LENGTH = 7;
const isSpace = (c: number) => c === 32 || c === 9 || c === NEWLINE || c === 13;

function startsRegex(src: string, slash: number): boolean {
  let k = slash - 1;
  while (k >= 0 && isSpace(src.charCodeAt(k))) k--;
  if (k === 1 && src.startsWith("#!")) return false; // shebang path, not `!/re/`
  if (k < 0 || BEFORE_REGEX.has(src.charCodeAt(k))) return true;
  return KEYWORD_BEFORE_REGEX.test(src.slice(Math.max(0, k - MAX_KEYWORD_LENGTH), k + 1));
}

// Index of the `/` closing the regex literal opened at `open`, or -1 when
// the line ends first (then it was a division after all).
function regexEnd(src: string, open: number): number {
  let inClass = false;
  for (let j = open + 1; j < src.length; j++) {
    const c = src.charCodeAt(j);
    if (c === NEWLINE) return -1;
    if (c === BACKSLASH) j++;
    else if (c === OPEN_BRACKET) inClass = true;
    else if (c === CLOSE_BRACKET) inClass = false;
    else if (c === SLASH && !inClass) return j;
  }
  return -1;
}

const SPACES = " ".repeat(256);
// Most blanked regions are a few characters on one line; those are cut from
// SPACES instead of going through a regex replace. The scan is bounded by
// the region — searching for the next newline from `from` would rescan the
// whole rest of a minified one-line file for every string in it.
function isShortSingleLine(src: string, from: number, to: number): boolean {
  if (to - from > SPACES.length) return false;
  for (let k = from; k < to; k++) if (src.charCodeAt(k) === NEWLINE) return false;
  return true;
}
// Same length, every char but "\n" replaced by a space.
const blank = (region: string) => region.replace(/[^\n]/g, " ");

const openerTable = (codes: number[]) => {
  const table = new Uint8Array(128);
  for (const code of codes) table[code] = 1;
  return table;
};
const REGION_OPENERS = [SLASH, HASH, LOWER_R, DOUBLE, SINGLE, BACKTICK];
const OPENS_REGION = openerTable(REGION_OPENERS);
const OPENS_REGION_OR_JSX = openerTable([...REGION_OPENERS, LESS, GREATER, OPEN_BRACE, CLOSE_BRACE]);
const OPENS_REGION_OR_HEREDOC = openerTable([...REGION_OPENERS, LESS, NEWLINE]);

const lineEnd = (src: string, from: number) => {
  const eol = src.indexOf("\n", from);
  return eol === -1 ? src.length : eol;
};

export type RegionKind = "comment" | "string" | "opaque";
export type RegionListener = (from: number, to: number, kind: RegionKind) => void;

export type Dialect = "c" | "json" | "javascript" | "jsx" | "rust" | "hash" | "shell";
export type StringView = "blank-strings" | "keep-strings";

const dialects = (...names: Dialect[]) => new Set<Dialect>(names);
const SINGLE_QUOTE_STRINGS = dialects("c", "javascript", "jsx", "hash", "shell");
const SLASH_COMMENTS = dialects("c", "json", "javascript", "jsx", "rust");
const HASH_COMMENTS = dialects("hash", "shell");
const REGEX_LITERALS = dialects("javascript", "jsx");

interface Scan {
  dialect: Dialect;
  jsxContexts: number[] | null;
  heredocBodyFrom: number;
  heredocBodyTo: number;
  from: number;
  to: number;
  resume: number;
  kind: RegionKind;
}

function region(scan: Scan, from: number, to: number, resume: number, kind: RegionKind): void {
  scan.from = from;
  scan.to = to;
  scan.resume = resume;
  scan.kind = kind;
}

const SHELL_WORD_BREAK = new Set(" \t\n\r;&|()".split("").map((c) => c.charCodeAt(0)));
const startsShellWord = (src: string, at: number) => at === 0 || SHELL_WORD_BREAK.has(src.charCodeAt(at - 1));

function commentEndAt(src: string, i: number, c: number, dialect: Dialect): number {
  if (c === HASH) return HASH_COMMENTS.has(dialect) && (dialect !== "shell" || startsShellWord(src, i)) ? lineEnd(src, i) : -1;
  if (c !== SLASH || !SLASH_COMMENTS.has(dialect)) return -1;
  const next = src.charCodeAt(i + 1);
  if (next === SLASH) return lineEnd(src, i);
  if (next !== STAR) return -1;
  const close = src.indexOf("*/", i + 2);
  return close === -1 ? src.length : close + 2;
}

function rustRawStringEnd(src: string, i: number): number {
  const next = src.charCodeAt(i + 1);
  if (next !== DOUBLE && next !== HASH) return -1;
  RAW_STRING_OPEN.lastIndex = i;
  const m = RAW_STRING_OPEN.exec(src);
  if (!m) return -1;
  const closer = `"${m[1]}`;
  const end = src.indexOf(closer, i + m[0].length);
  return end === -1 ? src.length : end + closer.length;
}

// Index of the delimiter closing the string opened at `open` (src.length if
// it never closes). A backslash escapes whatever follows it.
function stringEnd(src: string, open: number, quote: number): number {
  let j = open + 1;
  while (j < src.length && src.charCodeAt(j) !== quote) {
    if (src.charCodeAt(j) === BACKSLASH) j++;
    if (j < src.length) j++;
  }
  return j;
}

const HEREDOC_OPEN = /<<(-?)[ \t]*(["']?)([A-Za-z_]\w*)\2/y;

function heredocTerminatorLineStart(src: string, at: number): number {
  if (src.charCodeAt(at - 1) === LESS) return -1;
  HEREDOC_OPEN.lastIndex = at;
  const m = HEREDOC_OPEN.exec(src);
  if (!m) return -1;
  const leadingTabsAllowed = m[1] === "-";
  for (let lineStart = lineEnd(src, at) + 1; lineStart < src.length; ) {
    const end = lineEnd(src, lineStart);
    let line = src.slice(lineStart, end).replace(/\r$/, "");
    if (leadingTabsAllowed) line = line.replace(/^\t+/, "");
    if (line === m[3]) return lineStart;
    lineStart = end + 1;
  }
  return -1;
}

function scanHeredoc(src: string, i: number, c: number, scan: Scan): void {
  if (c === NEWLINE) {
    if (i + 1 === scan.heredocBodyFrom) region(scan, scan.heredocBodyFrom, scan.heredocBodyTo, scan.heredocBodyTo, "opaque");
    return;
  }
  const terminator = heredocTerminatorLineStart(src, i);
  if (terminator === -1) return;
  scan.heredocBodyFrom = lineEnd(src, i) + 1;
  scan.heredocBodyTo = terminator;
}

const JSX_TAG = 1, JSX_CLOSING_TAG = 2, JSX_CHILDREN = 3, JSX_EXPRESSION = 4;
const JSX_ELEMENT_OPEN = /<(?:>|[A-Za-z_$][\w$.:-]*(?![\w$.:-])(?!\s*(?:,|extends\b|>\s*\()))/y;

function jsxTextEnd(src: string, from: number): number {
  let j = from;
  while (j < src.length && src.charCodeAt(j) !== LESS && src.charCodeAt(j) !== OPEN_BRACE) j++;
  return j;
}

const afterJsxClose = (src: string, at: number, contexts: number[]) =>
  contexts[contexts.length - 1] === JSX_CHILDREN ? jsxTextEnd(src, at) : at;

function startsJsxElement(src: string, at: number): boolean {
  JSX_ELEMENT_OPEN.lastIndex = at;
  if (!JSX_ELEMENT_OPEN.test(src)) return false;
  let k = at - 1;
  while (k >= 0 && isSpace(src.charCodeAt(k))) k--;
  const afterArrow = k > 0 && src.charCodeAt(k) === GREATER && src.charCodeAt(k - 1) === EQUALS;
  return afterArrow || startsRegex(src, at);
}

function jsxTagStep(src: string, i: number, c: number, contexts: number[]): number {
  const tag = contexts[contexts.length - 1];
  if (c === OPEN_BRACE) return contexts.push(JSX_EXPRESSION), i + 1;
  if (c === SLASH && tag === JSX_TAG && src.charCodeAt(i + 1) === GREATER) {
    contexts.pop();
    return afterJsxClose(src, i + 2, contexts);
  }
  if (c !== GREATER) return c === LESS || c === CLOSE_BRACE ? i + 1 : -1;
  contexts.pop();
  if (tag === JSX_CLOSING_TAG) {
    contexts.pop();
    return afterJsxClose(src, i + 1, contexts);
  }
  contexts.push(JSX_CHILDREN);
  return jsxTextEnd(src, i + 1);
}

function jsxChildStep(src: string, i: number, c: number, contexts: number[]): number {
  if (c === OPEN_BRACE) return contexts.push(JSX_EXPRESSION), i + 1;
  if (c !== LESS) return Math.max(jsxTextEnd(src, i), i + 1);
  if (src.charCodeAt(i + 1) === SLASH) return contexts.push(JSX_CLOSING_TAG), i + 2;
  return contexts.push(JSX_TAG), i + 1;
}

function jsxCodeStep(src: string, i: number, c: number, contexts: number[]): number {
  const inJsx = contexts.length > 0;
  if (c === OPEN_BRACE && inJsx) contexts.push(JSX_EXPRESSION);
  if (c === CLOSE_BRACE && inJsx) {
    contexts.pop();
    return afterJsxClose(src, i + 1, contexts);
  }
  if (c === LESS && startsJsxElement(src, i)) contexts.push(JSX_TAG);
  return c === OPEN_BRACE || c === CLOSE_BRACE || c === LESS || c === GREATER ? i + 1 : -1;
}

function jsxStep(src: string, i: number, c: number, contexts: number[]): number {
  const top = contexts[contexts.length - 1];
  if (top === JSX_TAG || top === JSX_CLOSING_TAG) return jsxTagStep(src, i, c, contexts);
  if (top === JSX_CHILDREN) return jsxChildStep(src, i, c, contexts);
  return jsxCodeStep(src, i, c, contexts);
}

function scanLiteral(src: string, i: number, c: number, scan: Scan): void {
  if (c === LOWER_R) {
    const end = rustRawStringEnd(src, i);
    if (end !== -1) region(scan, i, end, end, "opaque");
    return;
  }
  if (c === SLASH) {
    const close = REGEX_LITERALS.has(scan.dialect) && startsRegex(src, i) ? regexEnd(src, i) : -1;
    if (close !== -1) region(scan, i + 1, close, close + 1, "opaque");
    return;
  }
  if (c === HASH || (c === SINGLE && !SINGLE_QUOTE_STRINGS.has(scan.dialect))) return;
  const close = stringEnd(src, i, c);
  region(scan, i + 1, close, Math.min(close + 1, src.length), "string");
}

function scanRegionAt(src: string, i: number, c: number, scan: Scan): void {
  region(scan, i, i, i + 1, "comment");
  if (scan.jsxContexts) {
    const afterJsx = jsxStep(src, i, c, scan.jsxContexts);
    if (afterJsx !== -1) return void (scan.resume = afterJsx);
  }
  if (scan.dialect === "shell" && (c === LESS || c === NEWLINE)) return scanHeredoc(src, i, c, scan);
  const commentEnd = commentEndAt(src, i, c, scan.dialect);
  if (commentEnd !== -1) return region(scan, i, commentEnd, commentEnd, "comment");
  scanLiteral(src, i, c, scan);
}

export function stripCommentsAndStrings(
  src: string,
  dialect: Dialect = "c",
  view: StringView = "blank-strings",
  onRegion?: RegionListener,
): string {
  const jsxContexts: number[] | null = dialect === "jsx" ? [] : null;
  const scan: Scan = {
    dialect, jsxContexts, heredocBodyFrom: -1, heredocBodyTo: -1, from: 0, to: 0, resume: 0, kind: "comment",
  };
  const keepStrings = view === "keep-strings";
  const opensRegion = jsxContexts ? OPENS_REGION_OR_JSX : dialect === "shell" ? OPENS_REGION_OR_HEREDOC : OPENS_REGION;
  const n = src.length;
  const out: string[] = [];
  let copiedUpTo = 0;
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c >= opensRegion.length || !opensRegion[c]) {
      i++;
      continue;
    }
    scanRegionAt(src, i, c, scan);
    i = scan.resume;
    if (scan.to <= scan.from) continue;
    if (onRegion) onRegion(scan.from, scan.to, scan.kind);
    if (keepStrings && scan.kind === "string") continue;
    if (scan.from > copiedUpTo) out.push(src.slice(copiedUpTo, scan.from));
    out.push(isShortSingleLine(src, scan.from, scan.to) ? SPACES.slice(0, scan.to - scan.from) : blank(src.slice(scan.from, scan.to)));
    copiedUpTo = scan.to;
  }
  if (copiedUpTo < n) out.push(src.slice(copiedUpTo));
  return out.join("");
}

export function memoizedStrip(dialect: Dialect): (src: string) => string {
  let last: { src: string; out: string } | null = null;
  return (src) => {
    if (last?.src !== src) last = { src, out: stripCommentsAndStrings(src, dialect) };
    return last.out;
  };
}

export function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
  return starts;
}

export function lineAt(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

export function countNonBlankLines(src: string): number {
  return src.split("\n").filter((l) => l.trim().length > 0).length;
}
