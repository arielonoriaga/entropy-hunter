import { describe, expect, test } from "bun:test";
import { stripCommentsAndStrings as strip, type Dialect, type RegionKind, type StringView } from "../src/languages/strip";

type Case = [what: string, source: string, dialect: Dialect, view: StringView, expected: string];

const BASICS: Case[] = [
  [
    "comments and string contents are blanked; quotes, length and line breaks stay",
    'const a = "hi // no"; // gone\n/* x\n y */ let b = BTtBT;', "c", "blank-strings",
    'const a = "        ";        \n    \n      let b = BT BT;',
  ],
  ["keep-strings leaves literals intact but still blanks comments", 'x === "a" // c', "c", "keep-strings", 'x === "a"     '],
  ["an escaped quote does not end the string", '"a\\"b" + c', "c", "blank-strings", '"    " + c'],
  ["an unterminated string runs to the end", 'x = "abc', "c", "blank-strings", 'x = "   '],
  [
    "Rust raw strings are blanked whole, and a lifetime is not a string",
    'let s = r#"a "quoted" b"#; fn f<\'a>() {}', "rust", "blank-strings",
    "let s =                  ; fn f<'a>() {}",
  ],
  ["hash comments in hash-comment languages", "a # b", "hash", "blank-strings", "a    "],
  ["hash is ordinary text otherwise", "a # b", "c", "blank-strings", "a # b"],
  ["a single quote is not a string in JSON", "{\"a\": \"it's\"} // c", "json", "blank-strings", "{\" \": \"    \"}     "],
];

const REGEX_LITERALS: Case[] = [
  ["division is left alone", "const r = (a + b) / 2 / c;", "javascript", "blank-strings", "const r = (a + b) / 2 / c;"],
  ["a slash inside a string is not a regex", "x = total / count; y = 'a/b';", "javascript", "blank-strings", "x = total / count; y = '   ';"],
  ["regex after a keyword; a slash inside a class does not end it", "return /a[/]b/.test(s);", "javascript", "blank-strings", "return /     /.test(s);"],
  ["regex after an operator", "if (!/^x$/.test(s)) {}", "javascript", "blank-strings", "if (!/   /.test(s)) {}"],
  ["a regex body is blanked even when strings are kept", 'x = /"/ + "s"', "javascript", "keep-strings", 'x = / / + "s"'],
  ["JSX closing tags are not regexes", "<div>{a}</div>", "javascript", "blank-strings", "<div>{a}</div>"],
  ["a shebang is not a regex", "#!/usr/bin/env node\nlet a;", "javascript", "blank-strings", "#!/usr/bin/env node\nlet a;"],
];

const DIALECTS: Case[] = [
  ["floor division in a hash-comment language is not a comment", "x = a // 2 # c", "hash", "blank-strings", "x = a // 2    "],
  ["shell: a hash only opens a comment at the start of a word", "n=DOLLAR{#a} # c", "shell", "blank-strings", "n=DOLLAR{#a}    "],
  ["shell: slashes are paths, not comments", "ls src/* http://a", "shell", "blank-strings", "ls src/* http://a"],
  ["shell: a heredoc body is blanked whole, its terminator kept", "cat <<EOF # c\na 'b\nEOF\nx", "shell", "blank-strings", "cat <<EOF    \n    \nEOF\nx"],
  ["JSX text is left alone, attribute strings are blanked", "<a href='u'>Don't // x</a>;", "jsx", "blank-strings", "<a href=' '>Don't // x</a>;"],
  ["a JSX expression container is code again", "<p>{/* c */ 'k'}</p>", "jsx", "blank-strings", "<p>{        ' '}</p>"],
  ["a comparison is not a JSX element", "a < b; // c", "jsx", "blank-strings", "a < b;     "],
];

const restore = (text: string) => text.replaceAll("BT", "`").replaceAll("DOLLAR", "$");

describe("stripCommentsAndStrings", () => {
  test.each([...BASICS, ...REGEX_LITERALS, ...DIALECTS])("%s", (_name, source, dialect, view, expected) => {
    const out = strip(restore(source), dialect, view);
    expect(out).toBe(restore(expected));
    expect(out.length).toBe(restore(source).length);
  });

  test("a quote inside a regex literal no longer opens a string", () => {
    const source = "const q = /['\"]/;\nfunction after() { return 1; }";
    expect(strip(source)).not.toContain("function after");
    expect(strip(source, "javascript")).toBe("const q = /    /;\nfunction after() { return 1; }");
  });

  test("a minified one-line file is stripped in linear time", () => {
    const source = Array.from({ length: 60_000 }, (_, i) => "a" + i + "=\"v" + i + "\";").join("");
    const started = performance.now();
    const out = strip(source);
    expect(out.length).toBe(source.length);
    expect(out.startsWith('a0="  ";a1="  ";')).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("shell shifts and heredocs are scanned in linear time", () => {
    const lines = (count: number) => Array.from({ length: count }, (_, i) => "x=DOLLAR(( a<<b" + i + " ))\ncat <<E" + i + "\n").join("").replaceAll("DOLLAR", "$");
    const started = performance.now();
    const out = strip(lines(16_000), "shell");
    expect(out.length).toBe(lines(16_000).length);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("the listener hears every comment and literal region with its kind", () => {
    const heard: [string, RegionKind][] = [];
    const source = "a = 'x' // c\nb = /re/;";
    strip(source, "javascript", "blank-strings", (from, to, kind) => heard.push([source.slice(from, to), kind]));
    expect(heard).toEqual([["x", "string"], ["// c", "comment"], ["re", "opaque"]]);
  });

  test("the scan loop creates no closures: one capturing the loop variables costs about 10x on the hottest loop of a cold run", () => {
    const body = strip.toString();
    expect(body).not.toContain("=>");
    expect(body).not.toMatch(/\bfunction\s*\(/);
  });
});
