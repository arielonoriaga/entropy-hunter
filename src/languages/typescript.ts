import type { DependencyResult, LanguageAnalyzer } from "./analyzer";
import { complexityFromMarkers, normalizedLinesFrom } from "./analyzer";
import { stripCommentsAndStrings } from "./strip";

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

// Function headers: declarations, assigned arrows/functions, class methods.
// Heuristic — inline anonymous callbacks are attributed to their enclosing
// named function rather than counted separately.
const FN_HEADER = new RegExp(
  [
    /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/.source,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/.source,
    /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|get\s+|set\s+|override\s+)*(?!(?:if|for|while|switch|catch|return|else|do|try|function|new|typeof|await|yield)\b)([A-Za-z_$][\w$]*)\s*\([^;=]*\)\s*(?::\s*[^{;=]+)?\{\s*$/.source,
  ].join("|"),
  "gm",
);
const DECISION = /\b(?:if|for|while|case|catch)\b|&&|\|\||\?\?/g;

function complexityHeaders(stripped: string) {
  // complexityFromMarkers matches per line; the class-method alternative is
  // anchored, which works line-by-line with the m flag.
  return complexityFromMarkers(
    stripped,
    new RegExp(FN_HEADER.source, "g"),
    DECISION,
  );
}

function resolveRelative(spec: string, fromDir: string, fileSet: Set<string>): string | null {
  const joined = [...(fromDir ? fromDir.split("/") : []), ...spec.split("/")];
  const parts: string[] = [];
  for (const seg of joined) {
    if (seg === "." || seg === "") continue;
    else if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const base = parts.join("/");
  const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, ""); // TS often imports './x.js'
  const candidates = [
    base,
    ...EXTENSIONS.map((e) => base + e),
    ...EXTENSIONS.map((e) => stem + e),
    ...EXTENSIONS.map((e) => `${base}/index${e}`),
  ];
  for (const c of candidates) if (fileSet.has(c)) return c;
  return null;
}

export const typescriptAnalyzer: LanguageAnalyzer = {
  language: "typescript",

  detect(path) {
    return EXTENSIONS.some((e) => path.endsWith(e)) && !path.endsWith(".d.ts");
  },

  complexity(source) {
    return complexityHeaders(stripCommentsAndStrings(source));
  },

  dependencies(source, path, fileSet): DependencyResult {
    // Strip comments but keep strings — import specifiers live in strings.
    const src = source;
    const internal = new Set<string>();
    const external = new Set<string>();
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

    const specs: string[] = [];
    for (const m of src.matchAll(/\b(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
    for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
    for (const m of src.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
    for (const m of src.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) specs.push(m[1]); // side-effect imports

    for (const spec of specs) {
      if (spec.startsWith(".")) {
        const hit = resolveRelative(spec, dir, fileSet);
        if (hit && hit !== path) internal.add(hit);
      } else {
        // Package import; scoped packages keep their scope.
        // ponytail: tsconfig path aliases unresolved → counted as external.
        const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        external.add(name);
      }
    }
    return { internal: [...internal].sort(), external: [...external].sort() };
  },

  normalizedLines(source) {
    return normalizedLinesFrom(stripCommentsAndStrings(source));
  },
};
