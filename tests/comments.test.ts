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
  ["clippy:: is an attribute, never a comment", "// clippy:: the cache is cold\nfn a() {}\n", "rust", [1]],
  ["a Python directive word is prose in JavaScript", "// type: ignore\n// pragma: no cover\nx;\n", "javascript", [1, 2]],
  ["an encoding declaration only counts on the first two lines", "x = 1\ny = 2\n# -*- coding: utf-8 -*-\n", "python", [3]],
  ["a global directive lists names, not a sentence", "/* global state is shared here */\nx;\n", "javascript", [1]],
  ["a copyright word mid-sentence is not a license header", "// see the Copyright section\nx;\n", "javascript", [1]],
  ["a copyright without a year is not a license header", "// we keep this because the\n// Copyright header must stay\nx;\n", "javascript", [1, 2]],
  ["a license header after the first line of code is just a comment", "x;\n// Copyright 2024 Someone\n", "javascript", [2]],
  ["only the license lines of the leading block are exempt", "// Copyright (c) 2024 Someone\n// Licensed MIT\n\n// why\nx;\n", "javascript", [2, 4]],
  ["prose in a license block is reported with its delimiters", "/**\n * @license MIT\n * Some text\n */\nx;\n", "javascript", [1, 3, 4]],
  ["prose after a copyright line is reported", "// Copyright 2024 Acme\n// This module doubles prices.\nx;\n", "javascript", [2]],
  ["Rust char and byte literals holding quotes are not strings that hide comments", "fn f() {\n    let c = '\"'; // real\n    let d = '\\''; let e = b'\"';\n}\nfn g<'a>(x: &'a str) {} // also\n", "rust", [2, 5]],
  ["a quoted-word heredoc with a backslash is text", "cat <<\\EOF\n# not a comment\nEOF\n# real\n", "shell", [4]],
  ["a shift inside arithmetic is not a heredoc", "x=DOLLAR(( a<<b ))\n# real\nb\n", "shell", [2]],
  ["a Python triple-quoted string is one string, whatever quotes it holds", 'def f():\n    """He said "hi\n# not a comment\n    """\n    return 1  # real\n', "python", [5]],
  ["a Python single-quoted triple string hides hashes too", "s = '''it's\n# text\n'''\n# real\n", "python", [4]],
  ["a shell hash inside a parameter expansion is not a comment", "n=DOLLAR{#items[@]}\necho DOLLAR#\n# why\n", "shell", [3]],
  ["a double-quoted shell string tracks the quotes nested in its substitutions", "x=\"DOLLAR(echo \"a # b\")\"\ny=\"DOLLAR{1:-\"default # v\"}\"\n# why\n", "shell", [3]],
  ["quotes inside a substitution inside a substitution stay inside", "x=\"DOLLAR(f DOLLAR(g \"a # b\") ')' )\" # real\n", "shell", [1]],
  ["a regex literal after a line ending in a comment is not a division", "const t = (\n  a || // why\n  /(^|\\/)x\\//.test(p)\n);\n", "javascript", [2]],
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
  ["biome", "// biome-ignore lint/suspicious/noDebugger\nx;\n", "javascript"],
  ["eslint-enable with rules", "/* eslint-enable no-console, no-alert */\nx;\n", "javascript"],
  ["several webpack hints", 'import(/* webpackChunkName: "a", webpackPrefetch: true */ "./a");\n', "javascript"],
  ["SPDX header", "// SPDX-License-Identifier: MIT OR Apache-2.0\nx;\n", "javascript"],
  ["license block", "/**\n * @license MIT\n */\nx;\n", "javascript"],
  ["copyright and SPDX lines", "// Copyright 2026 Someone\n// SPDX-License-Identifier: MIT\nx;\n", "javascript"],
  ["noqa with codes", "import os  # noqa: F401, E501\n", "python"],
  ["type ignore with codes", "x = f()  # type: ignore[attr-defined]\n", "python"],
  ["shellcheck with several directives", "# shellcheck disable=SC1090 source=/dev/null\n. x\n", "shell"],
  ["license header under a shebang", "#!/usr/bin/env node\n// Copyright (c) 2026 Someone\nx;\n", "javascript"],
  ["shebang", "#!/usr/bin/env bash\necho 1\n", "shell"],
  ["shellcheck", "# shellcheck disable=SC2086\necho a\n", "shell"],
  ["noqa", "import os  # noqa: F401\n", "hash"],
  ["type ignore", "x = f()  # type: ignore\n", "hash"],
  ["NOLINT", "int x; // NOLINT\n", "c"],
  ["rustfmt skip", "// rustfmt::skip\nfn a() {}\n", "rust"],
  ["a reason after an eslint directive", "// eslint-disable-next-line no-console -- we must log\nx;\n", "javascript"],
  ["a reason after eslint-enable", "// eslint-enable -- the cache is cold\nx;\n", "javascript"],
  ["an eslint config comment", "/* eslint no-console: off */\nx;\n", "javascript"],
  ["eslint globals", "/* global window, document: readonly */\nx;\n", "javascript"],
  ["a ts directive with its description", "// @ts-expect-error the upstream type is wrong\nx;\n", "javascript"],
  ["biome-ignore with its required reason", "// biome-ignore lint/style/noNonNullAssertion: checked above\nx;\n", "javascript"],
  ["pure annotation with a hash", "const a = /*#__PURE__*/ f();\n", "javascript"],
  ["pure annotation with an at sign", "const a = /* @__PURE__ */ f();\n", "javascript"],
  ["no-side-effects annotation", "/* @__NO_SIDE_EFFECTS__ */\nexport function f() {}\n", "javascript"],
  ["jsx import source", "/** @jsxImportSource @emotion/react */\nx;\n", "jsx"],
  ["jsx factory pragmas", "/** @jsx h */\n/** @jsxFrag Fragment */\n/** @jsxRuntime classic */\nx;\n", "jsx"],
  ["c8 and v8 ignore", "/* c8 ignore next 3 */\n/* v8 ignore start */\nx;\n", "javascript"],
  ["istanbul ignore with a reason", "/* istanbul ignore next: platform branch */\nx;\n", "javascript"],
  ["webpack magic comments", "import(/* webpackChunkName: \"a\" */ /* webpackPrefetch: true */ \"./a\");\n", "javascript"],
  ["a deprecation the type checker reads", "/** @deprecated Use g, it skips the offset trick. */\nexport function f() {}\n", "javascript"],
  ["spell-checker and editor folding markers", "// cspell:disable-next-line\n//#region helpers\nx;\n//#endregion\n", "javascript"],
  ["a source map url", "x;\n//# sourceMappingURL=a.js.map\n", "javascript"],
  ["a pragma-only Python line", "x = 1  # pragma: no cover\nif y:  # pragma: no branch\n    pass\n", "python"],
  ["black and isort switches", "# fmt: off\nx = [1,\n  2]\n# fmt: on\ny = 1  # fmt: skip\nimport a  # isort: skip\n", "python"],
  ["pyright and mypy", "x = f()  # pyright: ignore[reportGeneralTypeIssues]\n# mypy: disable-error-code=misc\n", "python"],
  ["type ignore with codes", "x = f()  # type: ignore[attr-defined]\n", "python"],
  ["noqa bare and with codes", "import os  # noqa\nimport re  # noqa: F401, E501\n", "python"],
  ["two pragmas on one line", "x = f()  # type: ignore  # noqa: E501\n", "python"],
  ["a coding line under a shebang", "#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\nx = 1\n", "python"],
  ["a coding line first", "# vim: set fileencoding=utf-8 :\nx = 1\n", "python"],
  ["a SAFETY comment clippy reads", "fn f() {\n    // SAFETY: the pointer is valid\n    unsafe { g() }\n}\n", "rust"],
  ["shellcheck with a reason", "# shellcheck disable=SC2086 # word splitting is wanted\necho a\n", "shell"],
  ["shellcheck source directive", "# shellcheck source=./lib.sh\n. ./lib.sh\n", "shell"],
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

  test("a decorator spanning several lines keeps the comment above it attached", () => {
    const source = "class S {\n  // why\n  @Retry({\n    times: 3,\n  })\n  run() {\n    return 1;\n  }\n}\n";
    expect(commentFactsOf(source, "javascript").lead_in_lines).toEqual([2, 3, 4, 5]);
    expect(commentFactsOf("/// doc\n#[derive(\n    Debug,\n)]\nstruct A;\n", "rust").lead_in_lines).toEqual([1, 2, 3, 4]);
  });
});
