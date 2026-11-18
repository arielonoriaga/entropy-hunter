import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rustAnalyzer } from "../src/languages/rust";
import { typescriptAnalyzer } from "../src/languages/typescript";
import {
  braceNesting, countChainedComparisons, dependenciesOf, indentNesting,
} from "../src/languages/analyzer";
import { genericAnalyzerFor } from "../src/languages/generic";

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

  test("a single-expression arrow helper does not steal complexity from the code after it", () => {
    // Regression: `config` used to "capture" every decision token in the
    // switch that follows it, because it has no `{` body of its own.
    const src = `function outer(cmd: string) {
  const config = () => loadConfig();
  switch (cmd) {
    case "a": return 1;
    case "b": return 2;
    case "c": return 3;
  }
  if (cmd) return 0;
}`;
    const cx = typescriptAnalyzer.complexity(src);
    const byName = Object.fromEntries(cx.functions.map((f) => [f.name, f.complexity]));
    expect(byName.config).toBe(1); // no decision tokens of its own
    expect(byName.outer).toBe(5); // 3 case + 1 if, attributed to the real enclosing function
  });

  test("a multi-line function signature is still recognized as block-bodied", () => {
    // Regression: checking only the header's OWN line for a trailing `{`
    // wrongly called this bodyless (signature spans 3 lines), which then
    // dumped every decision token after it into <module> instead of `outer`.
    const src = `export function outer(
  a: number,
  b: number,
): number {
  const helper = (x: number) => x * 2;
  if (a > b) return helper(a);
  if (a < b) return helper(b);
  return 0;
}`;
    const cx = typescriptAnalyzer.complexity(src);
    const byName = Object.fromEntries(cx.functions.map((f) => [f.name, f.complexity]));
    expect(byName.helper).toBe(1);
    expect(byName.outer).toBe(3); // 2 ifs, correctly attributed, not <module>
    expect(byName["<module>"]).toBeUndefined();
  });

  test("a const wrapped in a single hook call (createMemo/useMemo/useCallback) is its own header", () => {
    // Regression: `const x = createMemo(() => {...})` wasn't recognized as a
    // function header (the arrow isn't the direct RHS of `=`), so every
    // decision token inside it — and inside every sibling memo/effect that
    // followed — was silently attributed to whatever real function preceded
    // them. Found via two real files: CheckoutPanel.tsx's `banner` (reported
    // complexity 53 for a 4-branch if-chain) and ProductDetail.tsx's
    // `isFlavorProduct` (reported 39 for a one-line boolean check) — both
    // false positives caused by sibling `createMemo` consts leaking into them.
    const src = `function Component() {
  const trivial = () => true;
  const total = createMemo(() => {
    if (a) return 1;
    if (b) return 2;
    return 0;
  });
  const label = useMemo(() => {
    return cond ? "x" : "y";
  }, [cond]);
  return null;
}`;
    const cx = typescriptAnalyzer.complexity(src);
    const byName = Object.fromEntries(cx.functions.map((f) => [f.name, f.complexity]));
    expect(byName.trivial).toBe(1); // no decision tokens of its own
    expect(byName.total).toBe(3); // 2 ifs, attributed to itself, not `trivial`
    expect(byName.label).toBe(1); // ternary via `?` — no DECISION token match, but must not leak into `total`
    expect(byName.Component).toBe(1); // no decision tokens of its own
  });

  test("the wrapping hook call may carry explicit generic type arguments", () => {
    // Regression: `createMemo<number | null>(() => {...})` — found in
    // ProductDetail.tsx's `maxQty`/`lowStockHint` — wasn't recognized because
    // `<...>` sits between the hook name and its `(`.
    const src = `function Component() {
  const maxQty = createMemo<number | null>(() => {
    if (a) return 1;
    if (b) return 2;
    return null;
  });
  const other = () => true;
  return null;
}`;
    const cx = typescriptAnalyzer.complexity(src);
    const byName = Object.fromEntries(cx.functions.map((f) => [f.name, f.complexity]));
    expect(byName.maxQty).toBe(3); // 2 ifs, attributed to itself
    expect(byName.other).toBe(1); // not leaked into by maxQty's neighbor
  });
});

describe("state-space and clump extraction", () => {
  test("rust: Option and bool struct fields counted; enums contribute nothing", () => {
    const types = rustAnalyzer.stateSpace(read("rust/stateful/src/lib.rs"));
    expect(types.map((t) => t.name)).toEqual(["Connection", "Invoice"]); // enum skipped
    expect(types[0]).toMatchObject({ optional_fields: 4, boolean_fields: 2, clump_fields: 0 });
    // Invoice: order_id/order_date/order_total clump; customer_name alone is not
    expect(types[1]).toMatchObject({ clump_fields: 3, clump_prefix: "order" });
  });

  test("ts: optional/nullable/boolean fields counted; camelCase clumps detected", () => {
    const types = typescriptAnalyzer.stateSpace(read("typescript/stateful/model.ts"));
    expect(types.map((t) => t.name)).toEqual(["Request", "Checkout"]); // union skipped
    expect(types[0]).toMatchObject({ optional_fields: 3, boolean_fields: 2, clump_fields: 0 });
    expect(types[1]).toMatchObject({ clump_fields: 3, clump_prefix: "order" });
  });

  test("plain data types score zero on both axes", () => {
    expect(rustAnalyzer.stateSpace("pub struct P { pub x: i32, pub y: i32 }")[0]).toMatchObject({
      name: "P", optional_fields: 0, boolean_fields: 0, clump_fields: 0,
    });
    expect(typescriptAnalyzer.stateSpace("interface P { x: number; y: number }")[0]).toMatchObject({
      name: "P", optional_fields: 0, boolean_fields: 0, clump_fields: 0,
    });
  });

  test("boolean-ish prefixes (is_/has_) are not clumps; 2 shared prefixes are not enough", () => {
    const src =
      "pub struct S { pub is_open: bool, pub is_done: bool, pub is_new: bool, pub user_id: u64, pub user_name: String }";
    expect(rustAnalyzer.stateSpace(src)[0]).toMatchObject({ clump_fields: 0, clump_prefix: "" });
  });

  describe("nested optionality detection", () => {
    test("rust: Option<T> alone is depth 0 (exempt)", () => {
      const types = rustAnalyzer.stateSpace("pub struct P { pub name: Option<String> }");
      expect(types[0]).toMatchObject({ max_optional_depth: 0, nested_optional_occurrences: 0 });
    });

    test("rust: Option<Option<T>> is depth 1", () => {
      const types = rustAnalyzer.stateSpace("struct P { name: Option<Option<String>> }");
      expect(types[0]).toMatchObject({ max_optional_depth: 1, nested_optional_occurrences: 1 });
    });

    test("rust: Option<Option<Option<T>>> is depth 2", () => {
      const types = rustAnalyzer.stateSpace("struct P { name: Option<Option<Option<String>>> }");
      expect(types[0]).toMatchObject({ max_optional_depth: 2, nested_optional_occurrences: 1 });
    });

    test("rust: Option<Result<T, E>> and Result<Option<T>, E> and Vec<Option<T>> are NOT nested-Option", () => {
      const src = `
        struct A { a: Option<Result<String, u32>> }
        struct B { b: Result<Option<String>, u32> }
        struct C { c: Vec<Option<String>> }
      `;
      const types = rustAnalyzer.stateSpace(src);
      for (const t of types) {
        expect(t.max_optional_depth).toBe(0);
        expect(t.nested_optional_occurrences).toBe(0);
      }
    });

    test("rust: explicit enum state modeling is not flagged (enums are never scanned)", () => {
      const src = `
        enum FieldUpdate<T> {
          Unchanged,
          Clear,
          Set(T),
        }
      `;
      const types = rustAnalyzer.stateSpace(src);
      expect(types).toEqual([]);
    });

    test("rust: a composite field with two independent nested-Option occurrences counts as 2", () => {
      const src = "struct M { m: HashMap<Option<Option<u32>>, Option<Option<String>>> }";
      const types = rustAnalyzer.stateSpace(src);
      expect(types[0]).toMatchObject({ max_optional_depth: 1, nested_optional_occurrences: 2 });
    });

    test("rust: pub struct is public, pub(crate) struct is not", () => {
      const src = `
        pub struct Public { pub name: Option<Option<String>> }
        pub(crate) struct Internal { pub name: Option<Option<String>> }
      `;
      const types = rustAnalyzer.stateSpace(src);
      expect(types[0]).toMatchObject({ name: "Public", max_optional_depth: 1, is_pub: true });
      expect(types[1]).toMatchObject({ name: "Internal", max_optional_depth: 1, is_pub: false });
    });

    test("rust: tuple structs are not scanned (existing struct-header regex already excludes them)", () => {
      const types = rustAnalyzer.stateSpace("pub struct Patch(Option<Option<String>>);");
      expect(types).toEqual([]);
    });
  });
});

describe("magic literals", () => {
  test("ts: logic numbers and compared/case strings counted; const declarations exempt", () => {
    const magic = typescriptAnalyzer.magic(read("typescript/magic/pricing.ts"));
    // 0.85, 99.99, 12, 89.99, 79.99, 99.99 — TAX_RATE line exempt
    expect(magic.numbers).toBe(6);
    expect(magic.strings).toBe(2); // === "premium", case "vip"
  });

  test("rust: match-arm strings and logic numbers counted; const exempt", () => {
    const magic = rustAnalyzer.magic(read("rust/magic/src/lib.rs"));
    // 7, 250, 9, 11, 400 — FREE_SHIPPING_THRESHOLD line exempt
    expect(magic.numbers).toBe(5);
    expect(magic.strings).toBe(2); // == "north", "south" =>
  });

  test("0/1/2, numbers inside strings and comments never count", () => {
    const magic = typescriptAnalyzer.magic(
      'const x = arr[0] + 1; // 42 in a comment\nconst y = "version 3.14";\nlet z = 2;',
    );
    expect(magic.numbers).toBe(0);
    expect(magic.strings).toBe(0);
  });

  test("ts: a chain of 3+ comparisons against the same identifier counts as one aggravating hit on top of each comparison", () => {
    const magic = typescriptAnalyzer.magic(read("typescript/magic/chained-comparison.ts"));
    // STRING_COMPARE: 4 (showExportButtons) + 3 (isShortChain's status/status/role —
    // not a chain itself, see below) = 7, plus +1 for the one real chain
    // (showExportButtons: 4 comparisons, all against `tab()`) = 8.
    expect(magic.numbers).toBe(0);
    expect(magic.strings).toBe(8);
  });

  test("chained-comparison detector requires 3+ comparisons against the SAME identifier", () => {
    expect(countChainedComparisons('a !== "x" && a !== "y"')).toBe(0); // only 2
    expect(countChainedComparisons('a !== "x" && b !== "y" && c !== "z"')).toBe(0); // different idents
    expect(countChainedComparisons('a !== "x" && a !== "y" && a !== "z"')).toBe(1); // exactly 3
    expect(countChainedComparisons('tab() !== "a" && tab() !== "b" && tab() !== "c" && tab() !== "d"')).toBe(1); // call expressions
  });

  test("multi-line const object literals are exempt field-by-field, including nested blocks", () => {
    const src = `export const CONFIG = {
  retries: 5,
  timeouts: {
    connect: 30,
    read: 90,
  },
  label: "prod",
};
if (attempt > 12) fail();`;
    const magic = typescriptAnalyzer.magic(src);
    expect(magic.numbers).toBe(1); // only the 12 outside the const block
  });
});

describe("shared-condition (guard clump) detection", () => {
  test("ts: three sibling ifs sharing a leading conjunct form one group; unrelated ifs don't", () => {
    const groups = typescriptAnalyzer.sharedConditions(read("typescript/guards/checkout.ts"));
    expect(groups.length).toBe(1);
    expect(groups[0]).toMatchObject({ prefix: "isLoggedIn()", count: 2 });
  });

  test("rust: bare (no-paren) if conditions are matched the same way", () => {
    const groups = rustAnalyzer.sharedConditions(read("rust/guards/src/lib.rs"));
    expect(groups.length).toBe(1);
    expect(groups[0]).toMatchObject({ prefix: "is_admin", count: 3 });
  });

  test("a single guard, or guards with nothing after the leading conjunct, are not flagged", () => {
    const src = `function f(a: boolean) {
  if (a) { return 1; }
  if (a) { return 2; }
}`;
    // both conditions are BARE "a" with no second conjunct — nothing to
    // consolidate beyond plain duplication, which the duplication signal covers
    expect(typescriptAnalyzer.sharedConditions(src)).toEqual([]);
  });

  test("different indentation (different scope) breaks the group", () => {
    const src = `function outer(x: boolean, y: boolean) {
  if (x && a()) { f(); }
  if (x) {
    if (x && b()) { g(); }
  }
}`;
    const groups = typescriptAnalyzer.sharedConditions(src);
    expect(groups).toEqual([]); // the nested one is indented differently, no group
  });
});

describe("test-coverage-presence detection", () => {
  test("ts: co-located companion test file found", () => {
    const fileSet = new Set(["typescript/tested/math.ts", "typescript/tested/math.test.ts"]);
    const tc = typescriptAnalyzer.testCoverage(
      read("typescript/tested/math.ts"), "typescript/tested/math.ts", fileSet,
    );
    expect(tc).toEqual({ has_test: true, test_path: "typescript/tested/math.test.ts" });
  });

  test("ts: no companion test file found", () => {
    const fileSet = new Set(["typescript/complex/logic.ts"]);
    const tc = typescriptAnalyzer.testCoverage(
      read("typescript/complex/logic.ts"), "typescript/complex/logic.ts", fileSet,
    );
    expect(tc).toEqual({ has_test: false, test_path: "" });
  });

  test("ts: a test file itself never needs a test", () => {
    const tc = typescriptAnalyzer.testCoverage("", "src/foo.test.ts", new Set());
    expect(tc.has_test).toBe(true);
  });

  test("rust: inline #[cfg(test)] module counts as coverage", () => {
    const fileSet = new Set(["rust/tested/src/lib.rs"]);
    const tc = rustAnalyzer.testCoverage(
      read("rust/tested/src/lib.rs"), "rust/tested/src/lib.rs", fileSet,
    );
    expect(tc).toEqual({ has_test: true, test_path: "(inline)" });
  });

  test("rust: no inline test module found", () => {
    const tc = rustAnalyzer.testCoverage(
      read("rust/complex/src/lib.rs"), "rust/complex/src/lib.rs", new Set(),
    );
    expect(tc).toEqual({ has_test: false, test_path: "" });
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
    const deps = dependenciesOf(rustAnalyzer, 
      read("rust/coupled/src/payments.rs"),
      "rust/coupled/src/payments.rs",
      files,
    );
    expect(deps.internal).toEqual(["rust/coupled/src/orders.rs", "rust/coupled/src/shared.rs"]);
    expect(deps.external).toEqual(["serde"]);
  });

  test("mod declarations link main.rs to modules", () => {
    const deps = dependenciesOf(rustAnalyzer, 
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
    const deps = dependenciesOf(typescriptAnalyzer, 
      read("typescript/coupled/payments.ts"),
      "typescript/coupled/payments.ts",
      files,
    );
    expect(deps.internal).toEqual(["typescript/coupled/orders.ts", "typescript/coupled/shared.ts"]);
    expect(deps.external).toEqual(["zod"]);
  });

  test("scoped packages keep their scope; index and .js-suffix imports resolve", () => {
    const set = new Set(["a/b.ts", "a/c/index.ts", "a/d.ts"]);
    const deps = dependenciesOf(typescriptAnalyzer, 
      `import x from "./b";\nimport y from "./c";\nimport z from "./d.js";\nimport s from "@scope/pkg/sub";`,
      "a/main.ts",
      set,
    );
    expect(deps.internal).toEqual(["a/b.ts", "a/c/index.ts", "a/d.ts"]);
    expect(deps.external).toEqual(["@scope/pkg"]);
  });
});

describe("control-flow nesting", () => {
  // [what it shows, source, expected depth, expected line]
  const BRACES: [string, string, number, number][] = [
    ["a function body alone is not nesting", "function f() {\n  return 1;\n}", 0, 0],
    ["blocks inside one another add up", "function f() {\n  for (const a of b) {\n    if (a) {\n      while (c) {}\n    }\n  }\n}", 3, 4],
    ["else-if chains stay at one level", "if (a) {\n} else if (b) {\n} else {\n}", 1, 1],
    ["callbacks, object literals and classes do not count", "class A {\n  m() {\n    xs.forEach((x) => {\n      const o = { k: { v: 1 } };\n    });\n  }\n}", 0, 0],
    ["control flow inside a callback counts from where it is", "xs.map((x) => {\n  if (x) {\n    for (;;) {}\n  }\n});", 2, 3],
    ["a brace inside the condition is not the block", "if (check({ a: 1 })) {\n  if (b) {}\n}", 2, 2],
    ["semicolons in a for header do not end its head", "for (let i = 0; i < n; i++) {\n  if (a) {}\n}", 2, 2],
    ["a multi-line condition still opens a control block", "if (\n  a &&\n  b\n) {\n  if (c) {}\n}", 2, 5],
    ["a block used as a value counts", "const v = match x {\n  A => {\n    if y {}\n  }\n};", 2, 3],
    ["Rust `impl Trait for Type` is not a loop", "impl Display for Foo {\n  fn fmt(&self) {\n    if a {}\n  }\n}", 1, 3],
    ["unbalanced braces do not throw", "}}} if (a) {", 1, 1],
  ];
  test.each(BRACES)("braces: %s", (_name, source, depth, line) => {
    expect(braceNesting(source)).toEqual({ depth, line });
  });

  test("indentation: a header's body is whatever is indented deeper", () => {
    const source = "def f(xs):\n    for x in xs:\n        if x:\n            while x:\n                x -= 1\n        else:\n            pass\n    return 1\n";
    expect(indentNesting(source)).toEqual({ depth: 3, line: 4 });
    expect(indentNesting("x = 1\ny = 2\n")).toEqual({ depth: 0, line: 0 });
  });

  test("plugins pick the right reader; syntax without a block shape reports 0", () => {
    expect(typescriptAnalyzer.nesting('if (a) { if (b) { "}"; } }').depth).toBe(2); // a brace in a string is not a brace
    expect(rustAnalyzer.nesting("fn f() { loop { if a { } } }").depth).toBe(2);
    expect(genericAnalyzerFor("a.gd")!.nesting("func f():\n\tif a:\n\t\tfor b in c:\n\t\t\tpass\n").depth).toBe(2);
    expect(genericAnalyzerFor("a.go")!.nesting("func f() {\n for {\n  if a {\n  }\n }\n}").depth).toBe(2);
    expect(genericAnalyzerFor("a.rb")!.nesting("if a\n  if b\n  end\nend\n").depth).toBe(0);
  });
});

describe("function spans", () => {
  const spans = (cx: { functions: { name: string; line: number; end_line: number }[] }) =>
    cx.functions.map((f) => [f.name, f.line, f.end_line]);

  test("a function ends at its own closing line, not at the next header", () => {
    const src = [
      "export function a(",
      "  x: number,",
      "): number {",
      "  return x;",
      "}",
      "",
      "/** doc of b */",
      "export function b() {",
      "  const inner = () => {",
      "    return 1;",
      "  };",
      "  return inner();",
      "}",
      "export const after = 1;",
    ].join("\n");
    expect(spans(typescriptAnalyzer.complexity(src))).toEqual([["a", 1, 5], ["b", 8, 13], ["inner", 9, 11]]);
  });

  test("a single-line function spans its header only", () => {
    expect(spans(typescriptAnalyzer.complexity("function f() { return 1; }\nconst x = 2;\n"))).toEqual([["f", 1, 1]]);
  });

  test("an indentation-scoped function ends where the indentation does", () => {
    const python = genericAnalyzerFor("a.py")!;
    expect(spans(python.complexity("def f(x):\n    return x\n\nVALUE = 1\n"))).toEqual([["f", 1, 2]]);
  });

  test("a Rust where-clause stays inside the signature", () => {
    const src = "fn f<T>(x: T) -> T\nwhere\n    T: Clone,\n{\n    x\n}\n";
    expect(spans(rustAnalyzer.complexity(src))).toEqual([["f", 1, 6]]);
  });
});

describe("shell functions", () => {
  const shell = genericAnalyzerFor("run.sh")!;

  test("POSIX name() { and the function keyword both declare functions", () => {
    const src = "foo() {\n  if true; then echo 1; fi\n}\n\nfunction bar {\n  echo 2\n}\nbaz () {\n  echo 3\n}\n";
    const cx = shell.complexity(src);
    expect(cx.functions.map((f) => [f.name, f.complexity])).toEqual([["foo", 2], ["bar", 1], ["baz", 1]]);
  });

  test("a call with arguments or a command substitution is not a declaration", () => {
    expect(shell.complexity('foo "a" {b}\nx=$(date)\n').functions).toEqual([]);
  });
});
