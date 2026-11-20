import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { checkRepo } from "../src/check";
import { literalFindings } from "../src/literal-gate";
import { DEFAULT_CONFIG } from "../src/types";
import { tempRepo } from "./support";

const GateRule = { Literals: "literals" } as const;
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

  test.each([
    { query: "SELECT * FROM items WHERE status = 'a'", values: ["a"] },
    { query: "SELECT * FROM items WHERE status IN ('a', 'b')", values: ["a", "b"] },
    { query: "INSERT INTO items (status) VALUES ('a')", values: ["a"] },
    { query: "SELECT * FROM items WHERE status = ''", values: [] },
  ])("checks single-character SQL values in $query", ({ query, values }) => {
    for (const path of ["src/a.ts", "src/a.rs"]) {
      const findings = literalFindings(path, JSON.stringify(query) + ";", NEW);
      expect(findings).toHaveLength(values.length);
      for (const value of values) {
        expect(findings.some(finding => finding.includes('SQL discriminant "' + value + '"'))).toBe(true);
      }
    }
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

  test("a typeof check compares against the language's own type tags, not a domain value", () => {
    const src = 'if (typeof window.matchMedia === "function") go();\nif (typeof ResizeObserver !== "function") return;\n';
    expect(literalFindings("src/a.ts", src, NEW)).toEqual([]);
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
    const messages = on.files[0].findings.filter((f) => f.rule === GateRule.Literals).map((f) => f.message);
    expect(messages).toEqual([expect.stringContaining('line 2: string comparison with "new"')]);
    expect(run(false).files[0].findings.filter((f) => f.rule === GateRule.Literals)).toEqual([]);
  });

  test("the literals gate is on by default", () => {
    expect(DEFAULT_CONFIG.gate.literals).toBe(true);
  });
});

describe("literalFindings: lexical context regressions", () => {
  test.each([
    ['if (typeof value === "string" && value === "combo") go();', ["combo"]],
    ['if ("string" === typeof value && "combo" === value) go();', ["combo"]],
    ['const example = "if (key === \'combo\') go();";', []],
    ['if (typeof value === "combo") go();', ["combo"]],
  ])("scopes comparisons to their operands: %s", (source, expected) => {
    const findings = literalFindings("a.ts", source, NEW);
    expect(findings).toHaveLength(expected.length);
    expected.forEach(value => expect(findings.join("\n")).toContain('"' + value + '"'));
  });

  test.each([
    'pub(crate) const CODE: &str = "CATEGORY_NOT_FOUND";',
    'pub const CODE: &str =\n "CATEGORY_NOT_FOUND";',
    'pub(in crate::errors) const CODE: &str =\n "CATEGORY_NOT_FOUND";',
  ])("allows the constant home across visibility and lines: %s", source => {
    expect(literalFindings("a.rs", source, NEW)).toEqual([]);
  });

  test("an allowed home does not exempt another use on its line", () => {
    const source = 'const CODE: &str = "CATEGORY_NOT_FOUND"; fail("OTHER_ERROR");';
    expect(literalFindings("a.rs", source, NEW)).toEqual([expect.stringContaining('"OTHER_ERROR"')]);
  });

  test.each([
    ["a.rs", 'let q = r#"SELECT * FROM products WHERE product_type = \'combo\'"#;', 1],
    ["a.ts", "const q = `SELECT * FROM products WHERE\n product_type = 'combo'`;", 2],
    ["a.rs", 'let q = r##"SELECT * FROM products WHERE\n product_type = \'combo\'"##;', 2],
    ["a.ts", "const q = `SELECT * FROM products WHERE status IN (\n 'completed',\n 'void')`;", 2],
  ])("retains query context and literal lines: %s %s", (path, source, firstLine) => {
    const findings = literalFindings(path, source, NEW);
    expect(findings[0]).toContain("line " + firstLine + ": SQL discriminant");
    expect(literalFindings(path, source, onLines(firstLine - 1))).toEqual([]);
    expect(literalFindings(path, source, onLines(firstLine))).toHaveLength(1);
  });
});

describe("literal context through the CLI", () => {
  test("rejects raw SQL and domain comparisons, then accepts named values and documentation", () => {
    const repo = tempRepo("entropy-literal-cli-");
    const run = () => {
      const result = spawnSync(process.execPath, [new URL("../src/cli.ts", import.meta.url).pathname,
        "check", "--repo", repo.path, "--base", "HEAD", "--format", "json"], { encoding: "utf8" });
      return { status: result.status, report: JSON.parse(result.stdout) };
    };
    try {
      repo.write("src/a.ts", 'export const old = value === "old";\n');
      repo.commit("base");
      repo.write("src/a.ts", 'export const old = value === "old";\nif (typeof value === "string" && value === "combo") go();\n');
      repo.write("src/a.rs", 'let q = r#"SELECT * FROM products WHERE\n product_type = \'combo\'"#;\npub(crate) const CODE: &str =\n "CATEGORY_NOT_FOUND";\n');
      const rejected = run();
      expect(rejected.status).toBe(1);
      const literals = rejected.report.files.flatMap((file: { findings: { rule: string; message: string }[] }) =>
        file.findings.filter(finding => finding.rule === GateRule.Literals).map(finding => finding.message));
      expect(literals).toHaveLength(2);
      expect(literals).toEqual(expect.arrayContaining([
        expect.stringContaining('line 2: SQL discriminant "combo"'),
        expect.stringContaining('line 2: string comparison with "combo"'),
      ]));
      repo.write("src/a.ts", 'export const old = value === "old";\nconst example = "if (key === \'combo\') go();";\nif (typeof value === "string" && value === ProductKind.Combo) go();\n');
      repo.write("src/a.rs", 'let q = r#"SELECT * FROM products WHERE\n product_type = $1"#;\npub(crate) const CODE: &str =\n "CATEGORY_NOT_FOUND";\n');
      const accepted = run();
      expect(accepted.status).toBe(0);
      expect(accepted.report.verdict).toBe("pass");
    } finally {
      rmSync(repo.path, { recursive: true, force: true });
    }
  });
});

describe("literalFindings: JavaScript expression boundaries", () => {
  test.each([
    'typeof (value) === "string"',
    'typeof row[key] === "undefined"',
    'typeof getValue() === "object"',
    '"string" === typeof (value)',
    '"undefined" !== typeof row[key]',
    '("object") == (typeof getValue())',
    'typeof (getValue()) === ("function")',
    'typeof row?.[key] === "undefined"',
  ])("exempts genuine typeof operands: %s", expression => {
    expect(literalFindings("a.ts", "if (" + expression + ") go();", NEW)).toEqual([]);
  });

  test.each([
    ['key === `prefix-${id}`', []],
    ['key === ""', []],
    ['`prefix-${id}` !== key', []],
    ['key === `combo`', ["combo"]],
    ['key === (`combo`)', ["combo"]],
    ['kind === ("combo")', ["combo"]],
    ['(("combo")) === kind', ["combo"]],
    ['kind === ("combo" as const)', ["combo"]],
    ['key === `prefix-${kind === "combo"}`', ["combo"]],
    ['kind === `prefix-\\${id}`', ["prefix-${id}"]],
    ['typeof getValue() === "object" && kind === ("combo")', ["combo"]],
    ['typeof (value === "combo") === "boolean"', ["combo"]],
    ['typeof value + other === "string"', ["string"]],
  ])("distinguishes literal values from computed expressions: %s", (expression, values) => {
    const findings = literalFindings("a.ts", "if (" + expression + ") go();", NEW);
    expect(findings).toHaveLength(values.length);
    values.forEach(value => expect(findings.join("\n")).toContain('"' + value + '"'));
  });

  test.each([
    ['const message = `result: ${kind === "combo"}`;', 1],
    ['const message = `result: ${`nested: ${kind === ("combo")}`}`;', 1],
    ['const message = `escaped \\` tick ${kind === "combo"}`;', 1],
    ['const message = `result: ${(() => { const r = /[}]/; return kind === "combo"; })()}`;', 1],
    ['const message = `result: ${\n kind === "combo"\n}`;', 2],
  ])("visits executable template interpolations: %s", (source, line) => {
    expect(literalFindings("a.ts", source, NEW)).toEqual([expect.stringContaining('line ' + line + ': string comparison with "combo"')]);
    expect(literalFindings("a.ts", source, onLines(line))).toHaveLength(1);
    expect(literalFindings("a.ts", source, onLines(line + 1))).toEqual([]);
  });

  test.each([
    'const message = `kind === "combo"`;',
    'const message = `escaped \\${kind === "combo"}`;',
    'const pattern = /kind === "combo"/;',
    'const example = "if (key === \'combo\') go();";',
  ])("leaves documentation, escaped interpolation, and regex contents alone: %s", source => {
    expect(literalFindings("a.ts", source, NEW)).toEqual([]);
  });

  test("checks JSX expression containers", () => {
    expect(literalFindings("a.tsx", 'const view = <span>{`result: ${kind === "combo"}`}</span>;', NEW))
      .toEqual([expect.stringContaining('string comparison with "combo"')]);
  });
});

describe("literalFindings: AST source positions", () => {
  test("decodes escaped comparison text without changing physical source lines", () => {
    const source = 'const marker = 1;\nif (kind === "\\x63ombo") go();\n';
    expect(literalFindings("a.ts", source, onLines(2)))
      .toEqual([expect.stringContaining('line 2: string comparison with "combo"')]);
    expect(literalFindings("a.ts", source, onLines(1))).toEqual([]);
  });

  test("retains SQL context across interpolation and excludes its executable source", () => {
    const source = 'const q = sql`SELECT * FROM ${table} WHERE\n kind = \'combo\' AND note = ${"kind = \'ignored\'"}\n AND status IN (${param}, \'completed\')`;';
    expect(literalFindings("a.ts", source, NEW)).toEqual([
      expect.stringContaining('line 2: SQL discriminant "combo"'),
      expect.stringContaining('line 3: SQL discriminant "completed"'),
    ]);
    expect(literalFindings("a.ts", source, onLines(2))).toHaveLength(1);
    expect(literalFindings("a.ts", source, onLines(3))).toHaveLength(1);
    expect(literalFindings("a.ts", source, onLines(1))).toEqual([]);
  });

  test("checks escaped SQL delimiters at the original source line", () => {
    const source = "const q = 'SELECT * FROM products WHERE kind = \\'combo\\'';\n";
    expect(literalFindings("a.ts", source, NEW))
      .toEqual([expect.stringContaining('line 1: SQL discriminant "combo"')]);
  });
});
