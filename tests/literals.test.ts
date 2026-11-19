import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { checkRepo } from "../src/check";
import { literalFindings } from "../src/literal-gate";
import { DEFAULT_CONFIG } from "../src/types";
import { tempRepo } from "./support";

const NEW = { kind: "new-file" } as const;
const onLines = (...lines: number[]) => ({ kind: "diff" as const, added: new Set(lines), removedAfter: new Map<number, number>() });

describe("literalFindings: error codes (Rust)", () => {
  test("flags a SCREAMING_SNAKE code passed as a string", () => {
    const src = 'fn f() -> Result<(), AppError> {\n    Err(AppError::missing("CATEGORY_NOT_FOUND"))\n}\n';
    expect(literalFindings("src/a.rs", src, NEW)).toEqual([
      'line 2: error code "CATEGORY_NOT_FOUND" as a hardcoded string — name it with an enum variant whose code() match is the one place the text lives',
    ]);
  });

  test("the enum's own code() match arm, serde attributes and const declarations are the allowed homes", () => {
    const src = [
      "impl Refusal {",
      "    fn code(self) -> &'static str {",
      '        match self { Self::NotFound => "CATEGORY_NOT_FOUND" }',
      "    }",
      "}",
      '#[serde(rename = "SOME_CODE")]',
      'pub const LIMIT_CODE: &str = "PLAN_LIMIT_EXCEEDED";',
    ].join("\n");
    expect(literalFindings("src/a.rs", src, NEW)).toEqual([]);
  });

  test("text inside a comment is not code", () => {
    expect(literalFindings("src/a.rs", '// returns "CATEGORY_NOT_FOUND" when missing\nfn f() {}\n', NEW)).toEqual([]);
  });

  test("TypeScript is not checked for codes (the i18n tables are keyed by them)", () => {
    expect(literalFindings("src/a.ts", 'const k = "CATEGORY_NOT_FOUND";\n', NEW)).toEqual([]);
  });
});

describe("literalFindings: SQL discriminants", () => {
  test("flags a lowercase value compared in a query", () => {
    const src = 'let q = "UPDATE products SET x = 1 WHERE id = $1 AND product_type = \'combo\'";\n';
    expect(literalFindings("src/a.rs", src, NEW)).toEqual([
      'line 1: SQL discriminant "combo" as a hardcoded string — bind the enum\'s value (e.g. `Kind::Variant.as_str()`) instead of writing it into the query',
    ]);
  });

  test("flags a value inside a VALUES / IN list", () => {
    const src = '"INSERT INTO products (name, product_type) VALUES ($1, \'combo\')"\n';
    expect(literalFindings("src/a.rs", src, NEW)).toHaveLength(1);
    const inList = '"SELECT 1 FROM sales WHERE status IN (\'completed\', \'void\')"\n';
    expect(literalFindings("src/a.rs", inList, NEW)).toHaveLength(2);
  });

  test("a single-quoted JS argument or assignment is not SQL", () => {
    expect(literalFindings("src/a.ts", "const mode = 'combo';\ncall(a, 'combo');\n", NEW)).toEqual([]);
  });

  test("bound parameters pass", () => {
    expect(literalFindings("src/a.rs", '"WHERE id = $1 AND product_type = $2"\n', NEW)).toEqual([]);
  });
});

describe("literalFindings: string comparisons", () => {
  test("flags === / !== against a string, on either side, and case labels", () => {
    const src = [
      'if (e.pointerType !== "mouse") return;',
      'if ("combo" === p.product_type) go();',
      "switch (k) {",
      '  case "simple": break;',
      "}",
    ].join("\n");
    const found = literalFindings("src/a.ts", src, NEW);
    expect(found.map((f) => f.split(":")[0])).toEqual(["line 1", "line 2", "line 4"]);
    expect(found[0]).toContain('string comparison with "mouse"');
  });

  test("Rust == against a string is flagged; a FromStr match arm is not a comparison", () => {
    const src = 'if kind == "combo" {}\nmatch s { "combo" => Ok(Combo), _ => Err(()) }\n';
    expect(literalFindings("src/a.rs", src, NEW).map((f) => f.split(":")[0])).toEqual(["line 1"]);
  });

  test("comparing against an enum member passes", () => {
    expect(literalFindings("src/a.ts", "if (e.pointerType !== PointerKind.Mouse) return;\n", NEW)).toEqual([]);
  });
});

describe("literalFindings: only the lines this change added", () => {
  test("old literals on untouched lines are left for incremental cleanup", () => {
    const src = 'if (a === "x") one();\nif (b === "y") two();\n';
    expect(literalFindings("src/a.ts", src, onLines(2)).map((f) => f.split(":")[0])).toEqual(["line 2"]);
  });

  test("files in other languages are skipped", () => {
    expect(literalFindings("migrations/1.sql", "UPDATE t SET k = 'combo';\n", NEW)).toEqual([]);
  });
});

describe("entropy check: literals", () => {
  const cleanup: string[] = [];
  afterAll(() => cleanup.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  test("a new string comparison fails the check; [gate] literals = false turns it off", () => {
    const repo = tempRepo("entropy-literals-");
    cleanup.push(repo.path);
    repo.write("src/a.ts", 'export const isOld = (k: string) => k === "old";\n');
    repo.commit("base");
    repo.write("src/a.ts", 'export const isOld = (k: string) => k === "old";\nexport const isNew = (k: string) => k === "new";\n');
    const run = (literals: boolean) =>
      checkRepo(repo.path, { ...DEFAULT_CONFIG, gate: { ...DEFAULT_CONFIG.gate, literals } }, { base: "HEAD", since: "30d", only: null, touchedSince: null }, null, null);

    const on = run(true);
    expect(on.verdict).toBe("fail");
    const messages = on.files[0].findings.filter((f) => f.rule === "literals").map((f) => f.message);
    expect(messages).toEqual([expect.stringContaining('line 2: string comparison with "new"')]);
    expect(run(false).files[0].findings.filter((f) => f.rule === "literals")).toEqual([]);
  });

  test("the literals gate is on by default", () => {
    expect(DEFAULT_CONFIG.gate.literals).toBe(true);
  });
});
