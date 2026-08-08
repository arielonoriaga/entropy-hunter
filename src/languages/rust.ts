import type { DependencyResult, LanguageAnalyzer } from "./analyzer";
import { complexityFromMarkers, normalizedLinesFrom } from "./analyzer";
import { stripCommentsAndStrings } from "./strip";

const FN_HEADER = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g;
// Cyclomatic proxy: branch keywords + boolean operators + match arms (=>).
// `match` itself is not counted (its arms are, via =>).
const DECISION = /\b(?:if|while|loop|for)\b|&&|\|\||=>/g;

const STD_CRATES = new Set(["std", "core", "alloc"]);

// The engine calls complexity/dependencies/normalizedLines back-to-back on
// the same source — strip once, reuse (1-entry memo).
let memo: { src: string; out: string } | null = null;
function stripped(src: string): string {
  if (memo?.src !== src) memo = { src, out: stripCommentsAndStrings(src, { singleQuotes: false }) };
  return memo.out;
}

function tryPaths(fileSet: Set<string>, candidates: string[]): string | null {
  for (const c of candidates) if (fileSet.has(c)) return c;
  return null;
}

// Resolve a module path (segments) against a base directory: each prefix of
// the segments may be a file (`a/b.rs`) or a directory (`a/b/mod.rs`).
function resolveSegments(base: string, segments: string[], fileSet: Set<string>): string | null {
  for (let take = segments.length; take >= 1; take--) {
    const p = [base, ...segments.slice(0, take)].filter(Boolean).join("/");
    const hit = tryPaths(fileSet, [`${p}.rs`, `${p}/mod.rs`]);
    if (hit) return hit;
  }
  return null;
}

export const rustAnalyzer: LanguageAnalyzer = {
  language: "rust",

  detect(path) {
    return path.endsWith(".rs");
  },

  complexity(source) {
    return complexityFromMarkers(stripped(source), FN_HEADER, DECISION);
  },

  dependencies(source, path, fileSet): DependencyResult {
    const src = stripped(source);
    const internal = new Set<string>();
    const external = new Set<string>();

    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    // Crate src root: everything up to and including the last `src` segment.
    const srcIdx = path.split("/").lastIndexOf("src");
    const srcRoot = srcIdx >= 0 ? path.split("/").slice(0, srcIdx + 1).join("/") : "";
    const stem = path.replace(/\.rs$/, "");

    // mod x; → sibling module file
    for (const m of src.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gm)) {
      const name = m[1];
      const hit = tryPaths(fileSet, [
        `${dir ? dir + "/" : ""}${name}.rs`,
        `${dir ? dir + "/" : ""}${name}/mod.rs`,
        `${stem}/${name}.rs`,
        `${stem}/${name}/mod.rs`,
      ]);
      if (hit && hit !== path) internal.add(hit);
    }

    // use paths (handles `use a::b::{c, d}` at the group level only)
    for (const m of src.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([A-Za-z_:][A-Za-z0-9_:]*)/gm)) {
      const segs = m[1].split("::").filter(Boolean);
      if (segs.length === 0) continue;
      const head = segs[0];
      let hit: string | null = null;
      if (head === "crate") {
        hit = resolveSegments(srcRoot, segs.slice(1), fileSet);
        if (!hit && srcRoot) hit = tryPaths(fileSet, [`${srcRoot}/lib.rs`, `${srcRoot}/main.rs`]);
      } else if (head === "self") {
        hit = resolveSegments(dir, segs.slice(1), fileSet);
      } else if (head === "super") {
        let base = dir;
        let i = 0;
        while (segs[i] === "super") {
          base = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
          i++;
        }
        hit = resolveSegments(base, segs.slice(i), fileSet);
        if (!hit) hit = tryPaths(fileSet, [`${base}/mod.rs`, base ? `${base}.rs` : ""]);
      } else if (!STD_CRATES.has(head)) {
        // Could be an external crate or a sibling module referenced without
        // self:: (2015-style). Prefer internal resolution, else external.
        hit = resolveSegments(dir, segs, fileSet) ?? resolveSegments(srcRoot, segs, fileSet);
        if (!hit) external.add(head);
      }
      if (hit && hit !== path) internal.add(hit);
    }

    return { internal: [...internal].sort(), external: [...external].sort() };
  },

  normalizedLines(source) {
    return normalizedLinesFrom(stripped(source));
  },
};
