import type { DependencyResult, LanguageAnalyzer } from "./analyzer";
import {
  BRACE_SPANS, braceNesting, complexityFromMarkers, countMagic, extractBraceBlocks, fieldNames,
  findSharedConditionGroups, isTestFile, largestPrefixClump, normalizedLinesFrom,
} from "./analyzer";

const TEST_SUFFIXES = [
  ".test.ts", ".test.tsx", ".test.js", ".test.jsx",
  ".spec.ts", ".spec.tsx", ".spec.js", ".spec.jsx",
];
import { memoizedStrip, stripCommentsAndStrings } from "./strip";
import { commentFactsOf } from "./comments";

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

// Function headers: declarations, assigned arrows/functions, class methods.
// Heuristic — inline anonymous callbacks are attributed to their enclosing
// named function rather than counted separately.
const TYPE_PARAMETERS = String.raw`(?:<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>\s*)?`;
const FN_HEADER = new RegExp(
  [
    /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*TYPE_PARAMETERS\(/.source,
    // The RHS may be wrapped in a single hook/HOC call — `createMemo(() => {`,
    // `useMemo(() => {`, `on(dep, () => {`, `createMemo<T>(() => {` — so a
    // sibling memo/effect gets its own header instead of donating its decision
    // points to whatever real function preceded it (see the "wrapped in a
    // single hook call" / "generic type arguments" regressions).
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:[A-Za-z_$][\w$]*(?:<[^>]*>)?\(\s*)?(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/.source,
    /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|get\s+|set\s+|override\s+)*(?!(?:if|for|while|switch|catch|return|else|do|try|function|new|typeof|await|yield)\b)([A-Za-z_$][\w$]*)\s*TYPE_PARAMETERS\([^;=]*\)\s*(?::\s*[^{;=]+)?\{\s*$/.source,
  ].join("|").replaceAll("TYPE_PARAMETERS", TYPE_PARAMETERS),
  "gm",
);
const DECISION = /\b(?:if|for|while|case|catch)\b|&&|\|\||\?\?/g;
const IMPORT_PATTERNS = [
  /\b(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s+['"]([^'"]+)['"]/g, // side-effect imports
];

// The engine calls complexity/normalizedLines back-to-back on the same
// source — strip once, reuse (1-entry memo).
const stripped = memoizedStrip("javascript");

const CONST_DECLARATION = /^\s*(?:export\s+)?const\b/;
const IF_HEADER = /^(\s*)if\s*\((.+)\)\s*\{?\s*$/;
const JSX_EXTENSIONS = [".tsx", ".jsx"];
const PLAIN_JS_EXTENSIONS = [".js", ".mjs", ".cjs"];

const jsxStripped = memoizedStrip("jsx");

const FN_HEADER_MATCHED_PER_LINE = new RegExp(FN_HEADER.source, "gd");

function complexityHeaders(stripped: string) {
  return complexityFromMarkers(stripped, FN_HEADER_MATCHED_PER_LINE, DECISION, BRACE_SPANS);
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
    return complexityHeaders(stripped(source));
  },

  imports(source) {
    // Import specifiers live in strings, so this reads the raw source.
    const specs = new Set<string>();
    for (const pattern of IMPORT_PATTERNS) {
      for (const m of source.matchAll(pattern)) specs.add(m[1]);
    }
    return [...specs];
  },

  resolve(specs, path, fileSet, aliases): DependencyResult {
    const internal = new Set<string>();
    const external = new Set<string>();
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

    for (const spec of specs) {
      if (spec.startsWith(".")) {
        const hit = resolveRelative(spec, dir, fileSet);
        if (hit && hit !== path) internal.add(hit);
        continue;
      }
      // A tsconfig/jsconfig path alias (`~/x`, `@/x`) points back into the
      // repo; only when none resolves is the specifier a package.
      const aliased = aliases
        .candidates(spec, path)
        .map((candidate) => resolveRelative(candidate, "", fileSet))
        .find((hit) => hit !== null);
      if (aliased) {
        if (aliased !== path) internal.add(aliased);
        continue;
      }
      // Package import; scoped packages keep their scope.
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      external.add(name);
    }
    return { internal: [...internal].sort(), external: [...external].sort() };
  },

  normalizedLines(source) {
    return normalizedLinesFrom(stripped(source));
  },

  magic(source) {
    return countMagic(
      stripped(source),
      stripCommentsAndStrings(source, "javascript", "keep-strings"),
      CONST_DECLARATION,
    );
  },

  sharedConditions(source) {
    return findSharedConditionGroups(stripped(source), IF_HEADER);
  },

  nesting(source) {
    return braceNesting(stripped(source));
  },

  commentFacts: (source) => commentFactsOf(source, "javascript"),

  testCoverage(_source, path, fileSet) {
    if (isTestFile(path)) return { has_test: true, test_path: "" };
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const stem = path.replace(/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/, "");
    const base = stem.split("/").pop()!;
    const candidates = [
      ...TEST_SUFFIXES.map((s) => `${stem}${s}`), // co-located: dir/foo.test.ts
      ...TEST_SUFFIXES.map((s) => `${dir}/__tests__/${base}${s}`), // dir/__tests__/foo.test.ts
      // this repo's own convention: src/foo.ts -> tests/foo.test.ts
      ...(path.startsWith("src/") ? TEST_SUFFIXES.map((s) => `tests/${stem.slice(4)}${s}`) : []),
    ];
    const found = candidates.find((c) => fileSet.has(c)) ?? "";
    return { has_test: !!found, test_path: found };
  },

  stateSpace(source) {
    // Interfaces + object type aliases. Discriminated unions are the fix,
    // not the smell, so plain `type X = A | B` contributes nothing.
    return extractBraceBlocks(
      stripped(source),
      /\binterface\s+([A-Za-z_$][\w$]*)[^{]*\{|\btype\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=\s*\{/g,
    ).map(({ name, body }) => {
      const clump = largestPrefixClump(fieldNames(body));
      return {
        name,
        optional_fields:
          (body.match(/[\w$\])]\?\s*:/g) ?? []).length +
          (body.match(/\|\s*(?:null|undefined)\b/g) ?? []).length,
        boolean_fields: (body.match(/:\s*boolean\b/g) ?? []).length,
        clump_fields: clump.fields,
        clump_prefix: clump.prefix,
        max_optional_depth: 0,
        nested_optional_occurrences: 0,
        is_pub: false,
      };
    });
  },
};

export const jsxAnalyzer: LanguageAnalyzer = {
  ...typescriptAnalyzer,
  detect: (path) => JSX_EXTENSIONS.some((extension) => path.endsWith(extension)),
  complexity: (source) => complexityHeaders(jsxStripped(source)),
  normalizedLines: (source) => normalizedLinesFrom(jsxStripped(source)),
  magic: (source) =>
    countMagic(
      jsxStripped(source),
      stripCommentsAndStrings(source, "jsx", "keep-strings"),
      CONST_DECLARATION,
    ),
  sharedConditions: (source) => findSharedConditionGroups(jsxStripped(source), IF_HEADER),
  nesting: (source) => braceNesting(jsxStripped(source)),
  commentFacts: (source) => commentFactsOf(source, "jsx"),
};

export const javascriptAnalyzer: LanguageAnalyzer = {
  ...jsxAnalyzer,
  detect: (path) => PLAIN_JS_EXTENSIONS.some((extension) => path.endsWith(extension)),
};
