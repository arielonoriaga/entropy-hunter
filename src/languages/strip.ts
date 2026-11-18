// Replace comments and string contents with spaces, preserving line structure
// so token counts and line numbers stay meaningful. Deterministic single pass.
// ponytail: handles //, /* */, "", '', ``, and Rust r"..."/r#"..."# — not
// nested template-literal expressions or nested block comments; good enough
// for counting decision tokens.
// singleQuotes: false for Rust — `'` is usually a lifetime, not a string.
// hashComments: true for Python/Ruby/shell-style `#` line comments.
// keepStrings: blank only comments, leave string contents intact (for
// passes that inspect literals, e.g. magic-string detection).
// regexLiterals: true for JS/TS — blank the body of `/.../` literals too.
// A quote inside one (`/['"]/`) otherwise opens a "string" that swallows
// real code up to the next quote, taking function headers with it.
//
// Hot path of a cold run (every file is stripped at least once), so it works
// on char codes and whole slices: untouched runs are copied verbatim in one
// slice and blanked regions in one regex replace, instead of one array push
// per character.
const SLASH = 47, STAR = 42, HASH = 35, LOWER_R = 114, NEWLINE = 10;
const DOUBLE = 34, SINGLE = 39, BACKTICK = 96, BACKSLASH = 92;
const OPEN_BRACKET = 91, CLOSE_BRACKET = 93;
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

// ASCII characters that can open a comment, string or regex literal — the
// scan loop skips everything else without looking closer.
const OPENS_REGION = new Uint8Array(128);
for (const code of [SLASH, HASH, LOWER_R, DOUBLE, SINGLE, BACKTICK]) OPENS_REGION[code] = 1;

const lineEnd = (src: string, from: number) => {
  const eol = src.indexOf("\n", from);
  return eol === -1 ? src.length : eol;
};

// End of a region that is blanked whole — a comment, or a Rust raw string
// r"..." / r#"..."# — opening at `i`; -1 if none opens there.
function wholeRegionEnd(src: string, i: number, c: number, hashComments: boolean): number {
  const next = src.charCodeAt(i + 1);
  if (c === HASH) return hashComments ? lineEnd(src, i) : -1;
  if (c === SLASH && next === SLASH) return lineEnd(src, i);
  if (c === SLASH && next === STAR) {
    const close = src.indexOf("*/", i + 2);
    return close === -1 ? src.length : close + 2;
  }
  if (c !== LOWER_R || (next !== DOUBLE && next !== HASH)) return -1;
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

export type CommentListener = (from: number, to: number) => void;

function notifyIfComment(onComment: CommentListener | undefined, opener: number, from: number, to: number): void {
  if (onComment && to !== -1 && opener !== LOWER_R) onComment(from, to);
}

export function stripCommentsAndStrings(
  src: string,
  opts: {
    singleQuotes?: boolean; hashComments?: boolean; keepStrings?: boolean; regexLiterals?: boolean;
  } = {},
  onComment?: CommentListener,
): string {
  const singleQuotes = opts.singleQuotes ?? true;
  const hashComments = opts.hashComments ?? false;
  const keepStrings = opts.keepStrings ?? false;
  const regexLiterals = opts.regexLiterals ?? false;
  const n = src.length;
  const out: string[] = [];
  let copiedUpTo = 0;
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c >= OPENS_REGION.length || !OPENS_REGION[c]) {
      i++;
      continue;
    }
    let blankFrom = i;
    let blankTo = wholeRegionEnd(src, i, c, hashComments);
    notifyIfComment(onComment, c, i, blankTo);
    let resumeAt = blankTo;
    if (blankTo === -1) {
      const isRegex = c === SLASH;
      const opens = isRegex ? regexLiterals && startsRegex(src, i) : c !== LOWER_R && c !== HASH && (c !== SINGLE || singleQuotes);
      const close = !opens ? -1 : isRegex ? regexEnd(src, i) : stringEnd(src, i, c);
      if (close === -1) {
        i++;
        continue;
      }
      blankFrom = i + 1;
      blankTo = close;
      resumeAt = Math.min(close + 1, n);
      if (blankTo === blankFrom || (keepStrings && !isRegex)) {
        i = resumeAt;
        continue;
      }
    }
    if (blankFrom > copiedUpTo) out.push(src.slice(copiedUpTo, blankFrom));
    out.push(isShortSingleLine(src, blankFrom, blankTo) ? SPACES.slice(0, blankTo - blankFrom) : blank(src.slice(blankFrom, blankTo)));
    copiedUpTo = blankTo;
    i = resumeAt;
  }
  if (copiedUpTo < n) out.push(src.slice(copiedUpTo));
  return out.join("");
}

export function countNonBlankLines(src: string): number {
  return src.split("\n").filter((l) => l.trim().length > 0).length;
}
