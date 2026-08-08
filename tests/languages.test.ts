import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rustAnalyzer } from "../src/languages/rust";
import { typescriptAnalyzer } from "../src/languages/typescript";

const FIX = join(import.meta.dir, "..", "fixtures");
const read = (p: string) => readFileSync(join(FIX, p), "utf8");

describe("rust complexity", () => {
  test("simple functions score 1 each", () => {
    const cx = rustAnalyzer.complexity(read("rust/simple/src/lib.rs"));
    expect(cx.functions.map((f) => f.name)).toEqual(["add", "greet"]);
    expect(cx.total).toBe(2);
    expect(cx.max).toBe(1);
  });

  test("branches, loops, match arms and boolean ops add complexity", () => {
    const cx = rustAnalyzer.complexity(read("rust/complex/src/lib.rs"));
    const byName = Object.fromEntries(cx.functions.map((f) => [f.name, f.complexity]));
    // classify: 3 ifs + && + || = 1 + 5
    expect(byName.classify).toBe(6);
    // dispatch: 5 match arms (=>) = 1 + 5
    expect(byName.dispatch).toBe(6);
    // scan: for + if + while = 1 + 3
    expect(byName.scan).toBe(4);
    expect(cx.max).toBe(6);
    expect(cx.average).toBeCloseTo(16 / 3);
  });

  test("comments and strings do not add complexity", () => {
    const cx = rustAnalyzer.complexity(
      'fn f() { let s = "if && || for"; // if if if\n /* while */ }',
    );
    expect(cx.total).toBe(1);
  });
});

describe("typescript complexity", () => {
  test("simple functions score 1 each", () => {
    const cx = typescriptAnalyzer.complexity(read("typescript/simple/util.ts"));
    expect(cx.functions.map((f) => f.name)).toEqual(["add", "greet"]);
    expect(cx.total).toBe(2);
  });

  test("branches, cases, loops and ?? add complexity", () => {
    const cx = typescriptAnalyzer.complexity(read("typescript/complex/logic.ts"));
    const byName = Object.fromEntries(cx.functions.map((f) => [f.name, f.complexity]));
    // classify: 3 ifs + && + || = 6
    expect(byName.classify).toBe(6);
    // dispatch: 3 case = 4
    expect(byName.dispatch).toBe(4);
    // scan: for + if + while + ?? = 5
    expect(byName.scan).toBe(5);
  });
});

describe("rust dependency extraction", () => {
  const files = new Set([
    "rust/coupled/src/main.rs",
    "rust/coupled/src/orders.rs",
    "rust/coupled/src/payments.rs",
    "rust/coupled/src/shared.rs",
  ]);

  test("mod and use crate:: resolve to files; external crates split out", () => {
    const deps = rustAnalyzer.dependencies(
      read("rust/coupled/src/payments.rs"),
      "rust/coupled/src/payments.rs",
      files,
    );
    expect(deps.internal).toEqual(["rust/coupled/src/orders.rs", "rust/coupled/src/shared.rs"]);
    expect(deps.external).toEqual(["serde"]);
  });

  test("mod declarations link main.rs to modules", () => {
    const deps = rustAnalyzer.dependencies(
      read("rust/coupled/src/main.rs"),
      "rust/coupled/src/main.rs",
      files,
    );
    expect(deps.internal).toContain("rust/coupled/src/orders.rs");
    expect(deps.internal).toContain("rust/coupled/src/payments.rs");
    expect(deps.internal).toContain("rust/coupled/src/shared.rs");
  });
});

describe("typescript dependency extraction", () => {
  const files = new Set([
    "typescript/coupled/orders.ts",
    "typescript/coupled/payments.ts",
    "typescript/coupled/shared.ts",
  ]);

  test("relative imports resolve; packages are external", () => {
    const deps = typescriptAnalyzer.dependencies(
      read("typescript/coupled/payments.ts"),
      "typescript/coupled/payments.ts",
      files,
    );
    expect(deps.internal).toEqual(["typescript/coupled/orders.ts", "typescript/coupled/shared.ts"]);
    expect(deps.external).toEqual(["zod"]);
  });

  test("scoped packages keep their scope; index and .js-suffix imports resolve", () => {
    const set = new Set(["a/b.ts", "a/c/index.ts", "a/d.ts"]);
    const deps = typescriptAnalyzer.dependencies(
      `import x from "./b";\nimport y from "./c";\nimport z from "./d.js";\nimport s from "@scope/pkg/sub";`,
      "a/main.ts",
      set,
    );
    expect(deps.internal).toEqual(["a/b.ts", "a/c/index.ts", "a/d.ts"]);
    expect(deps.external).toEqual(["@scope/pkg"]);
  });
});
