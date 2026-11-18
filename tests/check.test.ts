import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRepo, recordWaiver, type CheckResult } from "../src/check";
import { GitError } from "../src/git";
import { Storage } from "../src/storage";
import { DEFAULT_CONFIG } from "../src/types";

const COMMENTS_GATED = { ...DEFAULT_CONFIG, gate: { ...DEFAULT_CONFIG.gate, comments: true } };

test("the comments gate is on by default; a repo opts out with [gate] comments = false", () => {
  expect(DEFAULT_CONFIG.gate.comments).toBe(true);
});
import { branchy, tempRepo, type TempRepo } from "./support";

const cleanup: string[] = [];
afterAll(() => cleanup.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

let repo: TempRepo;
beforeEach(() => {
  repo = tempRepo("entropy-check-");
  cleanup.push(repo.path);
  repo.write("src/pricing.ts", branchy("price", 3));
  repo.write("src/util.ts", "export const double = (n: number) => n * 2;\n");
  repo.commit("base");
});

const check = (storage: Storage | null = null, only: string[] | null = null, base = "HEAD"): CheckResult =>
  checkRepo(repo.path, COMMENTS_GATED, { base, since: "30d", only, touchedSince: null }, storage, null);
const fileOf = (result: CheckResult, path: string) => result.files.find((f) => f.path === path)!;
const rulesOf = (result: CheckResult, path: string) => fileOf(result, path).findings.map((f) => f.rule);

describe("entropy check", () => {
  test("no changes: passes without analyzing anything", () => {
    expect(check()).toMatchObject({ verdict: "pass", files: [], summary: { files_changed: 0 } });
  });

  test("a harmless edit passes", () => {
    repo.write("src/util.ts", "export const double = (n: number) => n * 2;\nexport const triple = (n: number) => n * 3;\n");
    const result = check();
    expect(result.verdict).toBe("pass");
    expect(fileOf(result, "src/util.ts")).toMatchObject({ status: "modified", verdict: "pass", findings: [] });
  });

  test("a function growing past the complexity limit fails, naming the function", () => {
    repo.write("src/pricing.ts", branchy("price", 20));
    const result = check();
    expect(result.verdict).toBe("fail");
    const finding = fileOf(result, "src/pricing.ts").findings.find((f) => f.rule === "complexity")!;
    expect(finding.level).toBe("fail");
    expect(finding.message).toContain("`price`");
    expect(finding.message).toContain("4 → 21");
  });

  test("complexity that was already there is not this change's regression", () => {
    repo.write("src/legacy.ts", branchy("legacy", 25));
    repo.commit("legacy lands");
    repo.write("src/legacy.ts", branchy("legacy", 25) + "export const one = 1;\n");
    expect(rulesOf(check(), "src/legacy.ts")).not.toContain("complexity");
  });

  test("renaming or extracting a complex function is not new complexity", () => {
    repo.write("src/legacy.ts", branchy("legacy", 25));
    repo.commit("legacy lands");
    repo.write("src/legacy.ts", branchy("renamed", 25));
    expect(rulesOf(check(), "src/legacy.ts")).not.toContain("complexity");
  });

  test("a new file is judged against nothing: complex and untested fails and warns", () => {
    repo.write("src/monster.ts", branchy("monster", 40));
    const result = check();
    const file = fileOf(result, "src/monster.ts");
    expect(file).toMatchObject({ status: "added", entropy_before: null, verdict: "fail" });
    expect(rulesOf(result, "src/monster.ts")).toEqual(expect.arrayContaining(["complexity", "untested", "orphan"]));
  });

  test("copy-pasting a block fails on duplication and names the other file", () => {
    const block = Array.from({ length: 12 }, (_, i) => `  total += items[${i}].price * rate${i};`).join("\n");
    repo.write("src/a.ts", `export function a(items: any[], total = 0) {\n${block}\n  return total;\n}\n`);
    repo.commit("a");
    repo.write("src/b.ts", `export function b(items: any[], total = 0) {\n${block}\n  return total;\n}\n`);
    const finding = fileOf(check(), "src/b.ts").findings.find((f) => f.rule === "duplication")!;
    expect(finding.level).toBe("fail");
    expect(finding.message).toContain("src/a.ts");
  });

  test("closing an import loop fails on the file that closed it", () => {
    repo.write("src/a.ts", 'import { b } from "./b";\nexport const a = () => b();\n');
    repo.write("src/b.ts", "export const b = () => 1;\n");
    repo.commit("a → b");
    repo.write("src/b.ts", 'import { a } from "./a";\nexport const b = () => a();\n');
    const result = check();
    expect(rulesOf(result, "src/b.ts")).toContain("cycle");
    expect(result.verdict).toBe("fail");
  });

  test("an inner layer importing an outer one fails on architecture", () => {
    repo.write("src/domain/order.ts", "export const order = 1;\n");
    repo.write("src/infrastructure/db.ts", "export const db = 1;\n");
    repo.commit("layers");
    repo.write("src/domain/order.ts", 'import { db } from "../infrastructure/db";\nexport const order = db;\n');
    expect(rulesOf(check(), "src/domain/order.ts")).toContain("architecture");
  });

  test("nesting control flow past the limit fails, naming the line and function; existing depth does not", () => {
    const nested = (depth: number) =>
      `export function route(x: number) {\n${"if (x) {\n".repeat(depth)}${"}\n".repeat(depth)}  return x;\n}\n`;
    repo.write("src/route.ts", nested(5));
    const finding = fileOf(check(), "src/route.ts").findings.find((f) => f.rule === "nesting")!;
    expect(finding.level).toBe("fail");
    expect(finding.message).toContain("0 → 5 deep at line 6");
    expect(finding.message).toContain("`route`");

    repo.commit("deep nesting lands");
    repo.write("src/route.ts", nested(5) + "export const one = 1;\n");
    expect(rulesOf(check(), "src/route.ts")).not.toContain("nesting");
  });

  test("a renamed file is compared with its old self, not treated as new", () => {
    repo.write("src/legacy.ts", branchy("legacy", 25));
    repo.commit("legacy lands");
    repo.git("mv", "src/legacy.ts", "src/moved.ts");
    const file = fileOf(check(), "src/moved.ts");
    expect(file).toMatchObject({ status: "renamed", base_path: "src/legacy.ts", verdict: "pass" });
    expect(file.entropy_before).not.toBeNull();
  });

  test("committed work is compared against the given base, not just HEAD", () => {
    const base = repo.git("rev-parse", "HEAD");
    repo.write("src/pricing.ts", branchy("price", 20));
    repo.commit("regression, committed");
    expect(check(null, null, "HEAD").files).toEqual([]);
    expect(check(null, null, base).verdict).toBe("fail");
  });

  test("--files narrows the verdict to the named paths", () => {
    repo.write("src/pricing.ts", branchy("price", 20));
    repo.write("src/util.ts", "export const double = (n: number) => n + n;\n");
    const result = check(null, ["src/util.ts"]);
    expect(result.files.map((f) => f.path)).toEqual(["src/util.ts"]);
    expect(result.verdict).toBe("pass");
  });

  test("--touched-since leaves out files last modified before that instant", () => {
    repo.write("src/pricing.ts", branchy("price", 20));
    repo.write("src/util.ts", "export const double = (n: number) => n + n;\n");
    const longAgo = new Date("2020-01-01T00:00:00Z");
    utimesSync(join(repo.path, "src/pricing.ts"), longAgo, longAgo);
    const options = { base: "HEAD", since: "30d", only: null, touchedSince: Date.now() - 60_000 };
    const result = checkRepo(repo.path, COMMENTS_GATED, options, null, null);
    expect(result.files.map((f) => f.path)).toEqual(["src/util.ts"]);
    expect(result.verdict).toBe("pass");
  });

  test("a waiver accepts a failing file as it is, until the file changes again", () => {
    const dir = mkdtempSync(join(tmpdir(), "entropy-waiver-"));
    cleanup.push(dir);
    const storage = new Storage(join(dir, "cache.db"));
    repo.write("src/pricing.ts", branchy("price", 20));
    expect(check(storage).verdict).toBe("fail");

    recordWaiver(storage, repo.path, "src/pricing.ts", "generated lookup table");
    const waived = check(storage);
    expect(waived.verdict).toBe("pass");
    expect(fileOf(waived, "src/pricing.ts")).toMatchObject({ verdict: "waived", waiver: "generated lookup table" });
    expect(waived.summary.waived).toBe(1);

    repo.write("src/pricing.ts", branchy("price", 21));
    expect(check(storage).verdict).toBe("fail");
    storage.close();
  });

  test("an unknown base is an error, not a silent pass", () => {
    expect(() => check(null, null, "no-such-ref")).toThrow(GitError);
  });
});

const commentsOf = (result: CheckResult, path: string) =>
  fileOf(result, path).findings.filter((f) => f.rule === "comments").map((f) => f.message);
const TWO_FUNCTIONS = [
  "export function a(x: number): number {",
  "  // why a",
  "  const y = x + 1;",
  "  return y;",
  "}",
  "",
  "export function b(x: number): number {",
  "  // why b",
  "  return x * 2;",
  "}",
  "",
].join("\n");

describe("entropy check: comments", () => {
  beforeEach(() => {
    repo.write("src/two.ts", TWO_FUNCTIONS);
    repo.commit("two functions with comments");
  });

  test("touching a function fails on the comments it still carries, and leaves untouched ones alone", () => {
    repo.write("src/two.ts", TWO_FUNCTIONS.replace("x + 1", "x + 2"));
    const result = check();
    expect(result.verdict).toBe("fail");
    expect(commentsOf(result, "src/two.ts")).toEqual([
      "function `a` (line 1) still carries 1 comment (line 2) — move the why into names/tests, then delete it",
    ]);
  });

  test("a new comment outside any function fails on its own line only", () => {
    const withModuleNote = "// existing note\n\n" + TWO_FUNCTIONS;
    repo.write("src/two.ts", withModuleNote);
    repo.commit("existing note");
    repo.write("src/two.ts", withModuleNote + "// fresh\nexport const z = 1;\n");
    expect(commentsOf(check(), "src/two.ts")).toEqual([
      "new comment outside any function at line 13 — move the why into names/tests, then delete it",
    ]);
  });

  test("deleting every comment of a touched function passes", () => {
    repo.write("src/two.ts", TWO_FUNCTIONS.replace("  // why a\n", ""));
    expect(commentsOf(check(), "src/two.ts")).toEqual([]);
  });

  test("deleting a statement inside a function touches it", () => {
    repo.write("src/two.ts", TWO_FUNCTIONS.replace("  const y = x + 1;\n", "").replace("return y;", "return x;"));
    expect(commentsOf(check(), "src/two.ts")).toHaveLength(1);
    repo.write("src/two.ts", TWO_FUNCTIONS.replace("  return x * 2;\n", "  return 0;\n"));
    expect(commentsOf(check(), "src/two.ts")[0]).toContain("`b`");
  });

  test("removing a whole function between two others touches neither neighbour", () => {
    const three = TWO_FUNCTIONS + "\nexport function c(): number {\n  // why c\n  return 3;\n}\n";
    repo.write("src/two.ts", three);
    repo.commit("three");
    repo.write("src/two.ts", three.replace(/export function b[^}]*}\n\n/, ""));
    expect(commentsOf(check(), "src/two.ts")).toEqual([]);
  });

  test("a doc comment directly above a function belongs to that function", () => {
    repo.write("src/two.ts", TWO_FUNCTIONS.replace("export function b", "/** b doc */\nexport function b"));
    repo.commit("doc");
    repo.write("src/two.ts", TWO_FUNCTIONS.replace("export function b", "/** b doc */\nexport function b").replace("x + 1", "x + 3"));
    expect(commentsOf(check(), "src/two.ts")).toEqual([
      "function `a` (line 1) still carries 1 comment (line 2) — move the why into names/tests, then delete it",
    ]);
  });

  test("a brand-new file reports every function's comments and every loose one", () => {
    repo.write("src/fresh.ts", "// top\n" + TWO_FUNCTIONS);
    const messages = commentsOf(check(), "src/fresh.ts");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("`a` (line 2) still carries 2 comments (lines 1, 3)");
    expect(messages[1]).toContain("`b` (line 8) still carries 1 comment (line 9)");
  });

  test("a renamed file is diffed against its old path", () => {
    repo.git("mv", "src/two.ts", "src/moved.ts");
    repo.write("src/moved.ts", TWO_FUNCTIONS.replace("x * 2", "x * 4"));
    expect(commentsOf(check(), "src/moved.ts")).toEqual([
      "function `b` (line 7) still carries 1 comment (line 8) — move the why into names/tests, then delete it",
    ]);
  });

  test("[gate] comments = false turns the rule off", () => {
    repo.write("src/two.ts", TWO_FUNCTIONS.replace("x + 1", "x + 2"));
    const config = { ...DEFAULT_CONFIG, gate: { ...DEFAULT_CONFIG.gate, comments: false } };
    const result = checkRepo(repo.path, config, { base: "HEAD", since: "30d", only: null, touchedSince: null }, null, null);
    expect(commentsOf(result, "src/two.ts")).toEqual([]);
  });
});

describe("entropy check: comments across languages", () => {
  test("a trailing comment on the closing line above belongs to that function, not to the next one", () => {
    const source = "export function a(): number {\n  return 1;\n} // end a\nexport function b(): number {\n  return 2;\n}\n";
    repo.write("src/trail.ts", source);
    repo.commit("trail");
    repo.write("src/trail.ts", source.replace("return 2;", "return 3;"));
    expect(commentsOf(check(), "src/trail.ts")).toEqual([]);
    repo.write("src/trail.ts", source.replace("return 1;", "return 0;"));
    expect(commentsOf(check(), "src/trail.ts")[0]).toContain("`a` (line 1) still carries 1 comment (line 3)");
  });

  test("a decorator between a comment and its function keeps the comment attached", () => {
    const source = "# about f\n@cache\ndef f(x):\n    return x\n";
    repo.write("src/deco.py", source);
    repo.commit("deco");
    repo.write("src/deco.py", source.replace("return x", "return x + 1"));
    expect(commentsOf(check(), "src/deco.py")[0]).toContain("`f` (line 3) still carries 1 comment (line 1)");
  });

  test("floor division, globs, URLs, heredocs and JSX text are not comments", () => {
    repo.write("src/calc.py", "def half(a):\n    return a // 2\n");
    repo.write("src/run.sh", "build() {\n  cp src/* out/\n  curl http://example.com/x\n  cat <<EOF\n# usage text\nEOF\n}\n");
    repo.write("src/view.tsx", "export function View() {\n  return <p>Don't miss https://example.com</p>;\n}\n");
    repo.commit("languages");
    repo.write("src/calc.py", "def half(a):\n    return a // 3\n");
    repo.write("src/run.sh", "build() {\n  cp src/* dist/\n  curl http://example.com/x\n  cat <<EOF\n# usage text\nEOF\n}\n");
    repo.write("src/view.tsx", "export function View() {\n  return <p>Don't miss https://example.org</p>;\n}\n// real\n");
    const result = check();
    expect(commentsOf(result, "src/calc.py")).toEqual([]);
    expect(commentsOf(result, "src/run.sh")).toEqual([]);
    expect(commentsOf(result, "src/view.tsx")).toEqual([
      "new comment outside any function at line 4 — move the why into names/tests, then delete it",
    ]);
  });

  test("user diff config that renames the patch prefixes cannot turn the rule off", () => {
    const source = "export function f(): number {\n  // old note about f\n  return 1;\n}\n";
    repo.write("src/pre.ts", source);
    repo.commit("pre");
    repo.git("config", "diff.noprefix", "true");
    repo.git("config", "diff.mnemonicPrefix", "true");
    repo.write("src/pre.ts", source.replace("return 1;", "return 2;"));
    expect(commentsOf(check(), "src/pre.ts")[0]).toContain("`f` (line 1) still carries 1 comment (line 2)");
  });

  test.each([
    [
      "a comment above a multi-line decorator stays with the method under it",
      "src/deco.ts",
      "export class S {\n  // retries because upstream drops the first call\n  @Retry({\n    times: 3,\n  })\n  run(): number {\n    return 1;\n  }\n}\n",
      ["return 1;", "return 2;"],
      "`run` (line 6) still carries 1 comment (line 2)",
    ],
    [
      "a function with braces in its type parameters is still a function",
      "src/gen.ts",
      "export function f<T extends { id: number }>(xs: T[]): number {\n  // keep the first id\n  return xs[0].id;\n}\n",
      ["xs[0]", "xs[1]"],
      "`f` (line 1) still carries 1 comment (line 2)",
    ],
  ])("%s", (_what, path, source, [from, to], expected) => {
    repo.write(path, source);
    repo.commit(path);
    repo.write(path, source.replace(from, to));
    expect(commentsOf(check(), path)[0]).toContain(expected);
  });

  test("a statement replaced by a blank line touches its function", () => {
    repo.write("src/two.ts", TWO_FUNCTIONS);
    repo.commit("two");
    repo.write("src/two.ts", TWO_FUNCTIONS.replace("  const y = x + 1;", "").replace("return y;", "return x;"));
    expect(commentsOf(check(), "src/two.ts")[0]).toContain("`a`");
  });

  test("both sides share one churn history, so a content-neutral edit leaves the file's entropy where it was", () => {
    for (let k = 0; k < 4; k++) {
      repo.write("src/busy.ts", "export const label = \"v" + k + "\";\n");
      repo.commit("busy " + k);
    }
    repo.write("src/busy.ts", "export const label = \"vX\";\n");
    expect(fileOf(check(), "src/busy.ts").delta).toBe(0);
  });
});

const TOOL_READ_ONLY: [string, string, string, [string, string], [string, string]][] = [
  [
    "bundler, JSX and lint directives in TypeScript",
    "src/tool.tsx",
    [
      "/** @jsxImportSource @emotion/react */",
      "export function view(x: number) {",
      "  const a = /*#__PURE__*/ make();",
      "  const b = /* @__PURE__ */ make();",
      "  // biome-ignore lint/style/noNonNullAssertion: checked above",
      "  const c = x!;",
      "  // @ts-expect-error the upstream type is wrong",
      "  const d: string = x;",
      "  // eslint-disable-next-line no-console -- the server swallows errors",
      "  console.log(a, b, c, d);",
      "  return import(/* webpackChunkName: \"v\" */ \"./v\");",
      "}",
      "",
    ].join("\n"),
    ["make();\n  const b", "make(1);\n  const b"],
    ["  return import", "  // why\n  return import"],
  ],
  [
    "coverage, formatter and type-checker pragmas in Python",
    "src/tool.py",
    "# -*- coding: utf-8 -*-\ndef f(x):\n    if x:  # pragma: no cover\n        return 1\n    y = g()  # type: ignore[attr-defined]  # noqa: E501\n    # fmt: off\n    z = [1,\n      2]\n    # fmt: on\n    return y  # pyright: ignore[reportGeneralTypeIssues]\n",
    ["return 1", "return 2"],
    ["    return y", "    # why\n    return y"],
  ],
  [
    "a SAFETY comment in Rust",
    "src/tool.rs",
    "pub fn f(p: *const u8) -> u8 {\n    // SAFETY: the caller hands over a valid pointer\n    unsafe { *p }\n}\n",
    ["unsafe { *p }", "unsafe { *p.add(0) }"],
    ["    unsafe", "    // why\n    unsafe"],
  ],
  [
    "nested quotes inside expansions and a shellcheck directive in shell",
    "src/tool.sh",
    'run() {\n  # shellcheck disable=SC2086 # splitting is wanted\n  x="DOLLAR(echo "a # b")"\n  y="DOLLAR{1:-"default # v"}"\n  z="BTecho "c # d"BT"\n  echo DOLLARx DOLLARy DOLLARz\n}\n',
    ["echo DOLLARx", "printf %s DOLLARx"],
    ["  z=", "  # why\n  z="],
  ],
];

const SPAN_MISSES: [string, string, string, [string, string], string][] = [
  [
    "deleting the last statements of a Python function touches it",
    "src/tail.py",
    "def f(x):\n    # why f\n    y = x + 1\n    print(y)\n    return y\n\n\ndef g():\n    return 2\n",
    ["    print(y)\n    return y\n", ""],
    "`f` (line 1) still carries 1 comment (line 2)",
  ],
  [
    "deleting the last statement of a method touches the method, not the class",
    "src/tail_method.py",
    "class A:\n    def m(self):\n        # why m\n        x = 1\n        return x\n",
    ["        return x\n", ""],
    "`m` (line 2) still carries 1 comment (line 3)",
  ],
  [
    "a generic arrow function is a function",
    "src/generic.ts",
    "export const pick = <T,>(xs: T[]): T => {\n  // the first wins\n  return xs[0];\n};\n",
    ["xs[0]", "xs[1]"],
    "`pick` (line 1) still carries 1 comment (line 2)",
  ],
  [
    "an async generic arrow with a constrained type parameter is a function",
    "src/generic_async.ts",
    "export const load = async <T extends { id: string }>(x: T): Promise<string> => {\n  // ids are opaque\n  return x.id;\n};\n",
    ["x.id;", "x.id.trim();"],
    "`load` (line 1) still carries 1 comment (line 2)",
  ],
];

describe("entropy check: comments tools read, and spans the old headers missed", () => {
  const shellText = (text: string) => text.replaceAll("DOLLAR", "$").replaceAll("BT", "`");

  test.each(TOOL_READ_ONLY)("a touched function holding only %s passes, and a plain comment beside them fails", (_what, path, source, edit, why) => {
    const [base, touched] = [shellText(source), shellText(source.replace(...edit))];
    repo.write(path, base);
    repo.commit(path);
    repo.write(path, touched);
    expect(commentsOf(check(), path)).toEqual([]);
    repo.write(path, shellText(source.replace(...edit).replace(...why)));
    expect(commentsOf(check(), path)).toHaveLength(1);
  });

  test.each(SPAN_MISSES)("%s", (_what, path, source, [from, to], expected) => {
    repo.write(path, source);
    repo.commit(path);
    repo.write(path, source.replace(from, to));
    expect(commentsOf(check(), path)[0]).toContain(expected);
  });

  test("removing a whole trailing method touches the method above it nowhere", () => {
    const source = "class A:\n    def m(self):\n        # why m\n        return 1\n\n    def n(self):\n        return 2\n";
    repo.write("src/drop.py", source);
    repo.commit("drop");
    repo.write("src/drop.py", source.replace("\n    def n(self):\n        return 2\n", ""));
    expect(commentsOf(check(), "src/drop.py")).toEqual([]);
  });
});
