import type { DependencyResult, LanguageAnalyzer } from "./analyzer";
import {
  braceNesting, complexityFromMarkers, countMagic, indentNesting, findSharedConditionGroups, isTestFile, normalizedLinesFrom,
} from "./analyzer";
import { stripCommentsAndStrings } from "./strip";
import { nonExemptCommentLines, type CommentSyntax } from "./comments";

// Language-agnostic fallback: churn, duplication, LOC and normalization are
// exact; complexity and dependencies are approximate (regex heuristics over
// common syntax families). Writing a dedicated plugin upgrades a language
// from "approximate" to "precise" — the engine doesn't care which it gets.

const EXT_LANGUAGE: Record<string, string> = {
  py: "python", go: "go", java: "java", rb: "ruby", php: "php",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
  cs: "csharp", kt: "kotlin", kts: "kotlin", swift: "swift",
  scala: "scala", dart: "dart", lua: "lua", ex: "elixir", exs: "elixir",
  sh: "shell", bash: "shell", zsh: "shell", zig: "zig", gd: "gdscript",
};
const INDENT_LANGS = new Set(["python", "gdscript"]);
const BRACE_LANGS = new Set([
  "go", "java", "php", "c", "cpp", "csharp", "kotlin", "swift", "scala", "dart", "zig",
]);
const HASH_COMMENT_LANGS = new Set(["python", "ruby", "shell", "elixir", "gdscript"]);

// Named function/method declarations across families; files whose functions
// escape these patterns still get a <module> pseudo-function.
const FN_HEADER =
  /\b(?:def|func|fn|function|sub|proc)\s+\(?[\w()[\] *]*?([A-Za-z_]\w*)\s*[({]/g;
const FN_HEADER_BY_LANGUAGE = new Map([
  ["shell", new RegExp(`${FN_HEADER.source}|^\\s*([A-Za-z_][\\w:-]*)\\s*\\(\\)\\s*(?:\\{|\\(|$)`, "g")],
]);
const COMMENT_SYNTAX_BY_LANGUAGE = new Map<string, CommentSyntax>([["shell", "shell"]]);
const commentSyntaxOf = (language: string): CommentSyntax =>
  COMMENT_SYNTAX_BY_LANGUAGE.get(language) ?? (HASH_COMMENT_LANGS.has(language) ? "hash" : "c");
// Union of branch keywords; `and`/`or` only matter where they're operators —
// elsewhere they can't appear as bare words outside stripped strings/comments.
const DECISION =
  /\b(?:if|elif|elsif|for|while|case|when|catch|except|rescue|and|or)\b|&&|\|\|/g;

function langOf(path: string): string | null {
  const ext = path.split(".").pop() ?? "";
  return EXT_LANGUAGE[ext] ?? null;
}

function strip(source: string, path: string): string {
  return stripCommentsAndStrings(source, {
    hashComments: HASH_COMMENT_LANGS.has(langOf(path) ?? ""),
  });
}

export function genericAnalyzerFor(path: string): LanguageAnalyzer | null {
  const language = langOf(path);
  if (!language) return null;
  return {
    language,
    detect: (p) => langOf(p) === language,
    complexity(source) {
      return complexityFromMarkers(strip(source, path), FN_HEADER_BY_LANGUAGE.get(language) ?? FN_HEADER, DECISION);
    },
    imports(source) {
      return [
        ...new Set(
          [
            ...source.matchAll(
              /^\s*(?:import|from|require|require_relative|include|use)\b[\s(]*['"]?([\w./-]+)/gm,
            ),
            ...source.matchAll(/^\s*#include\s+"([\w./-]+)"/gm),
            // GDScript: `preload("res://x.gd")` / `load(...)` anywhere in a line.
            ...source.matchAll(/\b(?:preload|load)\(\s*"res:\/\/([\w./-]+)"/g),
          ].map((m) => m[1]),
        ),
      ];
    },

    resolve(specs, from, fileSet): DependencyResult {
      const internal = new Set<string>();
      const external = new Set<string>();
      const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
      const ownExt = from.split(".").pop()!;
      for (const spec of specs) {
        // Python-style leading dots → same dir; then dots become slashes.
        const rel = spec.replace(/^\.+/, "").replace(/\./g, "/");
        const candidates = [
          `${dir}/${rel}.${ownExt}`, `${dir}/${rel}`, `${rel}.${ownExt}`, rel,
          `${dir}/${spec}`, spec,
        ];
        const hit = candidates.find((c) => fileSet.has(c));
        if (hit && hit !== from) internal.add(hit);
        else if (!spec.includes("/")) external.add(spec.replace(/^\.+/, "").split(".")[0]);
        else external.add(spec.split("/")[0]);
      }
      external.delete("");
      return { internal: [...internal].sort(), external: [...external].sort() };
    },
    normalizedLines(source) {
      return normalizedLinesFrom(strip(source, path));
    },
    magic(source) {
      return countMagic(
        strip(source, path),
        stripCommentsAndStrings(source, {
          hashComments: HASH_COMMENT_LANGS.has(language),
          keepStrings: true,
        }),
        /^\s*(?:const|final|static|readonly)\b|^[A-Z_][A-Z0-9_]*\s*=/,
      );
    },
    sharedConditions(source) {
      // Covers both `if (x && y) {`/`if x && y {` (C-like/Go) and Python's
      // colon-terminated, parenless, `and`-keyword form in one pass.
      return findSharedConditionGroups(
        strip(source, path),
        /^(\s*)if\s*\(?(.+?)\)?\s*[{:]\s*$/,
        /&&|\band\b/,
      );
    },
    nesting(source) {
      const stripped = strip(source, path);
      if (INDENT_LANGS.has(language)) return indentNesting(stripped);
      // `end`-delimited and shell syntax has no block shape to follow here.
      return BRACE_LANGS.has(language) ? braceNesting(stripped) : { depth: 0, line: 0 };
    },
    // Field-shape analysis needs typed syntax knowledge — dedicated plugins only.
    stateSpace: () => [],

    commentLines(source) {
      return nonExemptCommentLines(source, commentSyntaxOf(language));
    },

    testCoverage(_source, from, fileSet) {
      if (isTestFile(from)) return { has_test: true, test_path: "" };
      const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
      const ext = from.split(".").pop()!;
      const stem = from.slice(0, -(ext.length + 1));
      const base = stem.split("/").pop()!;
      let candidates: string[];
      if (language === "go") {
        candidates = [`${stem}_test.go`]; // the one true Go convention
      } else if (language === "python") {
        candidates = [
          `${stem}_test.py`, `${dir}/test_${base}.py`,
          `${dir}/tests/test_${base}.py`, `tests/test_${base}.py`,
        ];
      } else {
        // Best-effort for the rest: same-directory sibling only.
        candidates = [`${stem}_test.${ext}`, `${dir}/test_${base}.${ext}`, `${dir}/${base}Test.${ext}`];
      }
      const found = candidates.find((c) => fileSet.has(c)) ?? "";
      return { has_test: !!found, test_path: found };
    },
  };
}
