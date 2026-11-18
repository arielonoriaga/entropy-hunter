import { describe, expect, test } from "bun:test";
import { nonExemptCommentLines as commentLines, type CommentSyntax } from "../src/languages/comments";

const REPORTED: [string, string, CommentSyntax, number[]][] = [
  ["line, trailing and block comments cover every line they span", "// a\nx\n/* b\n c */ y // d\nz\n", "javascript", [1, 3, 4]],
  ["two comments on one line count that line once", "x /* a */ + /* b */ y\n", "javascript", [1]],
  ["markers inside strings and regex literals are not comments", 'const r = /\\/\\/x/;\nconst s = "// no";\n', "javascript", []],
  ["a Rust raw string is not a comment, a doc comment is", 'let s = r#"// x"#;\n/// doc\nfn a() {}\n', "rust", [2]],
  ["a pragma next to an explanatory comment exempts only itself", "// why\n// eslint-disable-next-line\nx;\n", "javascript", [1]],
  ["a copyright word mid-sentence is not a license header", "// see the Copyright section\nx;\n", "javascript", [1]],
  ["a shell hash inside a parameter expansion is not a comment", "n=${#items[@]}\necho $#\n# why\n", "shell", [3]],
  ["a shebang only counts on the first line", "echo 1\n#!/bin/sh\n", "shell", [2]],
  ["hash is plain text outside hash-comment languages", "int a = b # c;\n", "c", []],
];

const EXEMPT: [string, string, CommentSyntax][] = [
  ["eslint pragma", "// eslint-disable-next-line no-console\nx;\n", "javascript"],
  ["eslint block config", "/* eslint no-console: off */\nx;\n", "javascript"],
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
  ["shebang", "#!/usr/bin/env bash\necho 1\n", "shell"],
  ["shellcheck", "# shellcheck disable=SC2086\necho a\n", "shell"],
  ["noqa", "import os  # noqa: F401\n", "hash"],
  ["type ignore", "x = f()  # type: ignore\n", "hash"],
  ["Rust SAFETY", "// SAFETY: the pointer is valid\nunsafe { f() }\n", "rust"],
  ["NOLINT", "int x; // NOLINT\n", "c"],
];

describe("nonExemptCommentLines", () => {
  test.each(REPORTED)("%s", (_what, source, syntax, lines) => {
    expect(commentLines(source, syntax)).toEqual(lines);
  });

  test.each(EXEMPT)("tool-read comment is exempt: %s", (_what, source, syntax) => {
    expect(commentLines(source, syntax)).toEqual([]);
  });
});
