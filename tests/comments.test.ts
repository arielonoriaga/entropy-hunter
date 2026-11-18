import { describe, expect, test } from "bun:test";
import { commentFactsOf } from "../src/languages/comments";
import type { Dialect as CommentSyntax } from "../src/languages/strip";

const commentLines = (source: string, syntax: CommentSyntax) => commentFactsOf(source, syntax).lines;

const REPORTED: [string, string, CommentSyntax, number[]][] = [
  ["line, trailing and block comments cover every line they span", "// a\nx\n/* b\n c */ y // d\nz\n", "javascript", [1, 3, 4]],
  ["two comments on one line count that line once", "x /* a */ + /* b */ y\n", "javascript", [1]],
  ["markers inside strings and regex literals are not comments", 'const r = /\\/\\/x/;\nconst s = "// no";\n', "javascript", []],
  ["a Rust raw string is not a comment, a doc comment is", 'let s = r#"// x"#;\n/// doc\nfn a() {}\n', "rust", [2]],
  ["a pragma next to an explanatory comment exempts only itself", "// why\n// eslint-disable-next-line\nx;\n", "javascript", [1]],
  ["the prose under a block pragma is still a comment", "/* eslint-disable no-x\n * long explanation of why\n */\nx;\n", "javascript", [2, 3]],
  ["a word that only starts like a pragma is prose", "// @ts-why: reasons\n// eslint is wrong here\n// NOLINTED because\n// noqa-ish\nx;\n", "javascript", [1, 2, 3, 4]],
  ["SAFETY: is prose, not a tool directive", "// SAFETY: the pointer is valid\nunsafe { f() }\n", "rust", [1]],
  ["a copyright word mid-sentence is not a license header", "// see the Copyright section\nx;\n", "javascript", [1]],
  ["a copyright without a year is not a license header", "// we keep this because the\n// Copyright header must stay\nx;\n", "javascript", [1, 2]],
  ["a license header after the first line of code is just a comment", "x;\n// Copyright 2024 Someone\n", "javascript", [2]],
  ["only the leading block holding the license is exempt", "// Copyright (c) 2024 Someone\n// Licensed MIT\n\n// why\nx;\n", "javascript", [4]],
  ["a shell hash inside a parameter expansion is not a comment", "n=DOLLAR{#items[@]}\necho DOLLAR#\n# why\n", "shell", [3]],
  ["a shebang only counts on the first line", "echo 1\n#!/bin/sh\n", "shell", [2]],
  ["hash is plain text outside hash-comment languages", "int a = b # c;\n", "c", []],
  ["floor division in a hash-comment language is not a comment", "def f(a):\n    return a // 2\n", "hash", []],
  ["a shell glob and an unquoted URL are not comments", "for f in src/*; do\n  curl http://a/b\ndone\n# why\n", "shell", [4]],
  ["a heredoc body is text, not comments", "cat <<EOF\n# not a comment\nDon't\nEOF\necho '#x' # real\n", "shell", [5]],
  ["an indented heredoc ends at its tab-indented terminator", "cat <<-'END'\n\t# text\n\tEND\n# real\n", "shell", [4]],
  ["a here-string is not a heredoc", "cat <<<word\n# real\n", "shell", [2]],
  ["a URL in JSX text is not a comment", "export function A() {\n  return <p>Visit https://example.com now</p>;\n}\n", "jsx", []],
  ["an apostrophe in JSX text does not hide the comments after it", "const a = <p>Don't do it</p>;\n// real\nconst b = 'x';\n", "jsx", [2]],
  ["a JSX comment container is a comment, JSX text is not", "const a = <div>{/* c */}<b x='1'/>text // no</div>;\n// yes\n", "jsx", [1, 2]],
  ["a generic arrow in a .tsx file is not a JSX element", "const f = <T,>(x: T) => x; // why\nconst g = <T>(x: T) => x;\n// also\n", "jsx", [1, 3]],
].map(([what, source, ...rest]) => [what, (source as string).replaceAll("DOLLAR", "$"), ...rest]) as [string, string, CommentSyntax, number[]][];

const EXEMPT: [string, string, CommentSyntax][] = [
  ["eslint pragma", "// eslint-disable-next-line no-console\nx;\n", "javascript"],
  ["eslint block pragma on one line", "/* eslint-disable no-console */\nx;\n", "javascript"],
  ["ts directive", "// @ts-expect-error\nx;\n", "javascript"],
  ["triple-slash reference", '/// <reference types="node" />\nx;\n', "javascript"],
  ["bundler hint", 'import(/* webpackChunkName: "a" */ "./a");\n', "javascript"],
  ["vite hint", "import(/* @vite-ignore */ p);\n", "javascript"],
  ["coverage hint", "/* istanbul ignore next */\nx;\n", "javascript"],
  ["prettier", "// prettier-ignore\nx;\n", "javascript"],
  ["biome", "// biome-ignore lint/style: reason\nx;\n", "javascript"],
  ["SPDX header", "// SPDX-License-Identifier: MIT\nx;\n", "javascript"],
  ["license block", "/**\n * @license MIT\n * Some text\n */\nx;\n", "javascript"],
  ["multi-line copyright run", "// Copyright 2026 Someone\n// Licensed under MIT\nx;\n", "javascript"],
  ["license header under a shebang", "#!/usr/bin/env node\n// Copyright (c) 2026 Someone\nx;\n", "javascript"],
  ["shebang", "#!/usr/bin/env bash\necho 1\n", "shell"],
  ["shellcheck", "# shellcheck disable=SC2086\necho a\n", "shell"],
  ["noqa", "import os  # noqa: F401\n", "hash"],
  ["type ignore", "x = f()  # type: ignore\n", "hash"],
  ["NOLINT", "int x; // NOLINT\n", "c"],
  ["rustfmt skip", "// rustfmt::skip\nfn a() {}\n", "rust"],
];

describe("commentFactsOf", () => {
  test.each(REPORTED)("%s", (_what, source, syntax, lines) => {
    expect(commentLines(source, syntax)).toEqual(lines);
  });

  test.each(EXEMPT)("tool-read comment is exempt: %s", (_what, source, syntax) => {
    expect(commentLines(source, syntax)).toEqual([]);
  });

  test("lead-in lines are comment-only lines and decorator lines, never code with a trailing comment", () => {
    const facts = commentFactsOf("} // end a\n// about b\n@cache\nfunction b() {}\n", "javascript");
    expect(facts.lead_in_lines).toEqual([2, 3]);
    expect(commentFactsOf("/// doc\n#[inline]\nfn f() {}\n", "rust").lead_in_lines).toEqual([1, 2]);
  });
});
