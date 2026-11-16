import { describe, expect, test } from "bun:test";
import { joinPath, loadAliases } from "../src/aliases";
import { dependenciesOf } from "../src/languages/analyzer";
import { typescriptAnalyzer } from "../src/languages/typescript";
import type { SourceTree } from "../src/tree";

function tree(files: Record<string, string>): SourceTree {
  return { files: Object.keys(files), read: (path) => files[path] ?? null };
}

describe("joinPath", () => {
  test("normalizes dot segments", () => {
    expect(joinPath("frontend", "./src/*")).toBe("frontend/src/*");
    expect(joinPath("a/b", "../c")).toBe("a/c");
    expect(joinPath("", ".")).toBe("");
  });
});

describe("tsconfig path aliases", () => {
  const project = tree({
    // JSONC: comments and a trailing comma, as real tsconfigs have.
    "frontend/tsconfig.json": `{
      // aliases
      "compilerOptions": { "paths": { "~/*": ["./src/*"], "@lib": ["./src/lib/index.ts"], }, },
    }`,
    "frontend/src/App.tsx": "",
    "frontend/src/lib/index.ts": "",
    "frontend/src/pages/Home.tsx": "",
    "backend/main.ts": "",
  });
  const aliases = loadAliases(project);

  test("wildcard and exact patterns map to repo-relative candidates", () => {
    expect(aliases.candidates("~/pages/Home", "frontend/src/App.tsx")).toEqual(["frontend/src/pages/Home"]);
    expect(aliases.candidates("@lib", "frontend/src/App.tsx")).toEqual(["frontend/src/lib/index.ts"]);
    expect(aliases.candidates("solid-js", "frontend/src/App.tsx")).toEqual([]);
  });

  test("a config applies only to files beneath it", () => {
    expect(aliases.candidates("~/pages/Home", "backend/main.ts")).toEqual([]);
  });

  test("aliased imports become internal dependencies instead of packages", () => {
    const files = new Set(project.files.filter((f) => /\.tsx?$/.test(f)));
    const source = `import Home from "~/pages/Home";\nimport lib from "@lib";\nimport { render } from "solid-js/web";`;
    const deps = dependenciesOf(typescriptAnalyzer, source, "frontend/src/App.tsx", files, aliases);
    expect(deps.internal).toEqual(["frontend/src/lib/index.ts", "frontend/src/pages/Home.tsx"]);
    expect(deps.external).toEqual(["solid-js"]);
    // Without the resolver the same imports are (wrongly) all packages.
    expect(dependenciesOf(typescriptAnalyzer, source, "frontend/src/App.tsx", files).internal).toEqual([]);
  });

  test("extends inherits paths; baseUrl anchors them and resolves bare specifiers", () => {
    const inherited = loadAliases(
      tree({
        "tsconfig.base.json": `{ "compilerOptions": { "baseUrl": "./app", "paths": { "@/*": ["*"] } } }`,
        "web/tsconfig.json": `{ "extends": "../tsconfig.base.json" }`,
        "web/main.ts": "",
      }),
    );
    expect(inherited.candidates("@/util/x", "web/main.ts")).toEqual(["app/util/x", "app/@/util/x"]);
    expect(inherited.candidates("util/x", "web/main.ts")).toEqual(["app/util/x"]);
  });

  test("an unreadable config contributes nothing instead of failing the run", () => {
    expect(loadAliases(tree({ "tsconfig.json": "{ not json", "a.ts": "" })).candidates("~/x", "a.ts")).toEqual([]);
  });
});
