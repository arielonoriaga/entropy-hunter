import type { DependencyResult, LanguageAnalyzer } from "./analyzer";
import {
  complexityFromMarkers, countMagic, extractBraceBlocks, fieldNames,
  findSharedConditionGroups, isTestFile, largestPrefixClump, normalizedLinesFrom,
} from "./analyzer";
import { stripCommentsAndStrings } from "./strip";

const FN_HEADER = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g;
// Cyclomatic proxy: branch keywords + boolean operators + match arms (=>).
// `match` itself is not counted (its arms are, via =>).
const DECISION = /\b(?:if|while|loop|for)\b|&&|\|\||=>/g;

// Contiguous "Option<Option<...Option<" runs — a run's Option-count minus 1
// is its nesting depth beyond the first (unremarkable) layer.
const NESTED_OPTION = /Option\s*<\s*Option\s*<(?:\s*Option\s*<)*/g;
// Public API surface: `pub struct Name` only — pub(crate)/pub(super) are
// crate-internal, not public API, and must NOT match here.
const PUB_STRUCT = /\bpub\s+struct\s+([A-Za-z_]\w*)/g;

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
    // (^|;|]) start: also catches `#[cfg(test)] mod x;` sharing the attribute's line
    for (const m of src.matchAll(/(?:^|;|\])\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(?:r#)?([A-Za-z_][A-Za-z0-9_]*)\s*;/gm)) {
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

  magic(source) {
    return countMagic(
      stripped(source),
      stripCommentsAndStrings(source, { singleQuotes: false, keepStrings: true }),
      /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\b/,
    );
  },

  sharedConditions(source) {
    // Rust `if` has no parens: `if a && b {`.
    return findSharedConditionGroups(stripped(source), /^(\s*)if\s+(.+?)\s*\{\s*$/);
  },

  testCoverage(source, path) {
    if (isTestFile(path)) return { has_test: true, test_path: "" };
    // Idiomatic Rust: unit tests live inline in an `#[cfg(test)] mod tests`
    // block within the same file, not a separate companion file.
    const inline = /#\[cfg\(test\)\]|#\[test\]/.test(source);
    return { has_test: inline, test_path: inline ? "(inline)" : "" };
  },

  stateSpace(source) {
    const src = stripped(source);
    const pubStructs = new Set([...src.matchAll(PUB_STRUCT)].map((m) => m[1]));
    // Struct fields only; enums are the fix, not the smell.
    return extractBraceBlocks(
      src,
      /\bstruct\s+([A-Za-z_]\w*)[^{;(]*\{/g,
    ).map(({ name, body }) => {
      const clump = largestPrefixClump(fieldNames(body));
      const nestedMatches = [...body.matchAll(NESTED_OPTION)];
      const maxDepth = nestedMatches.reduce(
        (best, m) => Math.max(best, (m[0].match(/Option/g)!.length) - 1),
        0,
      );
      return {
        name,
        optional_fields: (body.match(/:\s*Option\s*</g) ?? []).length,
        boolean_fields: (body.match(/:\s*bool\b/g) ?? []).length,
        clump_fields: clump.fields,
        clump_prefix: clump.prefix,
        max_optional_depth: maxDepth,
        nested_optional_occurrences: nestedMatches.length,
        is_pub: pubStructs.has(name),
      };
    });
  },
};
