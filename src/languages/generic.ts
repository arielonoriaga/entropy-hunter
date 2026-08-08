import type { DependencyResult, LanguageAnalyzer } from "./analyzer";
import {
  complexityFromMarkers, countMagic, findSharedConditionGroups, normalizedLinesFrom,
} from "./analyzer";
import { stripCommentsAndStrings } from "./strip";

// Language-agnostic fallback: churn, duplication, LOC and normalization are
// exact; complexity and dependencies are approximate (regex heuristics over
// common syntax families). Writing a dedicated plugin upgrades a language
// from "approximate" to "precise" — the engine doesn't care which it gets.

const EXT_LANGUAGE: Record<string, string> = {
  py: "python", go: "go", java: "java", rb: "ruby", php: "php",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
  cs: "csharp", kt: "kotlin", kts: "kotlin", swift: "swift",
  scala: "scala", dart: "dart", lua: "lua", ex: "elixir", exs: "elixir",
  sh: "shell", bash: "shell", zsh: "shell", zig: "zig",
};
const HASH_COMMENT_LANGS = new Set(["python", "ruby", "shell", "elixir"]);

// Named function/method declarations across families; files whose functions
// escape these patterns still get a <module> pseudo-function.
const FN_HEADER =
  /\b(?:def|func|fn|function|sub|proc)\s+\(?[\w()[\] *]*?([A-Za-z_]\w*)\s*[({]/g;
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
      return complexityFromMarkers(strip(source, path), FN_HEADER, DECISION);
    },
    dependencies(source, from, fileSet): DependencyResult {
      const internal = new Set<string>();
      const external = new Set<string>();
      const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
      const ownExt = from.split(".").pop()!;
      const specs = [
        ...source.matchAll(
          /^\s*(?:import|from|require|require_relative|include|use)\b[\s(]*['"]?([\w./-]+)/gm,
        ),
        ...source.matchAll(/^\s*#include\s+"([\w./-]+)"/gm),
      ].map((m) => m[1]);
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
    // Field-shape analysis needs typed syntax knowledge — dedicated plugins only.
    stateSpace: () => [],
  };
}
