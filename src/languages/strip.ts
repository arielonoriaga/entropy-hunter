// Replace comments and string contents with spaces, preserving line structure
// so token counts and line numbers stay meaningful. Deterministic single pass.
// ponytail: handles //, /* */, "", '', ``, and Rust r"..."/r#"..."# — not
// nested template-literal expressions or nested block comments; good enough
// for counting decision tokens.
// singleQuotes: false for Rust — `'` is usually a lifetime, not a string.
export function stripCommentsAndStrings(src: string, opts: { singleQuotes?: boolean } = {}): string {
  const singleQuotes = opts.singleQuotes ?? true;
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  const push = (c: string) => out.push(c === "\n" ? "\n" : " ");
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") push(src[i++]);
    } else if (c === "/" && next === "*") {
      push(src[i++]);
      push(src[i++]);
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) push(src[i++]);
      if (i < n) { push(src[i++]); push(src[i++]); }
    } else if (c === "r" && (next === '"' || (next === "#" && src.slice(i).match(/^r#+"/)))) {
      // Rust raw string r"..." / r#"..."#
      const m = src.slice(i).match(/^r(#*)"/);
      if (m) {
        const close = `"${m[1]}`;
        const end = src.indexOf(close, i + m[0].length);
        const stop = end === -1 ? n : end + close.length;
        while (i < stop) push(src[i++]);
      } else {
        out.push(src[i++]);
      }
    } else if (c === '"' || c === "`" || (c === "'" && singleQuotes)) {
      const quote = c;
      out.push(src[i++]); // keep the quote itself
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") push(src[i++]);
        if (i < n) push(src[i++]);
      }
      if (i < n) out.push(src[i++]);
    } else {
      out.push(src[i++]);
    }
  }
  return out.join("");
}

export function countNonBlankLines(src: string): number {
  return src.split("\n").filter((l) => l.trim().length > 0).length;
}
