import { describe, expect, test } from "bun:test";
import { stripCommentsAndStrings as strip } from "../src/languages/strip";

type Options = Parameters<typeof strip>[1];
// [what it shows, source, options, expected]
type Case = [string, string, Options, string];

const BASICS: Case[] = [
  [
    "comments and string contents are blanked; quotes, length and line breaks stay",
    'const a = "hi // no"; // gone\n/* x\n y */ let b = `t`;', {},
    'const a = "        ";        \n    \n      let b = ` `;',
  ],
  ["keepStrings leaves literals intact but still blanks comments", 'x === "a" // c', { keepStrings: true }, 'x === "a"     '],
  ["an escaped quote does not end the string", '"a\\"b" + c', {}, '"    " + c'],
  ["an unterminated string runs to the end", 'x = "abc', {}, 'x = "   '],
  [
    "Rust raw strings are blanked whole, and a lifetime is not a string",
    'let s = r#"a "quoted" b"#; fn f<\'a>() {}', { singleQuotes: false },
    "let s =                  ; fn f<'a>() {}",
  ],
  ["hash comments when asked", "a # b", { hashComments: true }, "a    "],
  ["hash is ordinary text otherwise", "a # b", {}, "a # b"],
];

const JS: Options = { regexLiterals: true };
const REGEX_LITERALS: Case[] = [
  ["division is left alone", "const r = (a + b) / 2 / c;", JS, "const r = (a + b) / 2 / c;"],
  ["a slash inside a string is not a regex", "x = total / count; y = 'a/b';", JS, "x = total / count; y = '   ';"],
  ["regex after a keyword; a slash inside a class does not end it", "return /a[/]b/.test(s);", JS, "return /     /.test(s);"],
  ["regex after an operator", "if (!/^x$/.test(s)) {}", JS, "if (!/   /.test(s)) {}"],
  ["a regex body is blanked even when strings are kept", 'x = /"/ + "s"', { ...JS, keepStrings: true }, 'x = / / + "s"'],
  ["JSX closing tags are not regexes", "<div>{a}</div>", JS, "<div>{a}</div>"],
  ["a shebang is not a regex", "#!/usr/bin/env node\nlet a;", JS, "#!/usr/bin/env node\nlet a;"],
];

describe("stripCommentsAndStrings", () => {
  test.each([...BASICS, ...REGEX_LITERALS])("%s", (_name, source, options, expected) => {
    const out = strip(source, options);
    expect(out).toBe(expected);
    expect(out.length).toBe(source.length);
  });

  test("a quote inside a regex literal no longer opens a string", () => {
    const source = "const q = /['\"]/;\nfunction after() { return 1; }";
    // Without regex awareness the `'` swallows everything up to the next quote.
    expect(strip(source)).not.toContain("function after");
    expect(strip(source, JS)).toBe("const q = /    /;\nfunction after() { return 1; }");
  });

  test("a minified one-line file is stripped in linear time", () => {
    const source = Array.from({ length: 60_000 }, (_, i) => `a${i}="v${i}";`).join("");
    const started = performance.now();
    const out = strip(source);
    expect(out.length).toBe(source.length);
    expect(out.startsWith('a0="  ";a1="  ";')).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000); // quadratic took minutes
  });
});
