import { stripCommentsAndStrings } from "./strip";

export type CommentSyntax = "c" | "javascript" | "rust" | "hash" | "shell";

const STRIP_OPTIONS: Record<CommentSyntax, Parameters<typeof stripCommentsAndStrings>[1]> = {
  c: {},
  javascript: { regexLiterals: true },
  rust: { singleQuotes: false },
  hash: { hashComments: true },
  shell: { hashComments: true },
};

interface Region {
  from: number;
  to: number;
}

const COMMENT_MARKERS = /^\s*(?:\/\/[/!]?|\/\*+!?|\*+\/?|#+!?)?\s*/;
const TOOL_PRAGMA = new RegExp(
  "^(?:" + [
    "eslint[\\s-]", "tslint:", "prettier-ignore", "biome-ignore", "oxlint-",
    "(?:istanbul|c8|v8) ignore", "@ts-", "<reference\\s", "webpack[A-Z]\\w*:", "@vite-ignore",
    "shellcheck\\s", "noqa\\b", "type:\\s*ignore", "pylint:", "rubocop:", "NOLINT",
    "clippy::", "rustfmt::skip", "SAFETY:",
  ].join("|") + ")",
);
const LICENSE = /^(?:SPDX-License-Identifier:|@license\b|Copyright\b|\(c\)\s)/;
const SHELL_WORD_BOUNDARY = /[\s;&|()]/;
const HASH = 35;
const NEWLINE = 10;

const bodiesOf = (text: string) => text.split("\n").map((line) => line.replace(COMMENT_MARKERS, ""));

function isShebang(src: string, region: Region): boolean {
  return region.from === 0 && src.startsWith("#!");
}

function isToolPragma(src: string, region: Region): boolean {
  return isShebang(src, region) || TOOL_PRAGMA.test(bodiesOf(src.slice(region.from, region.to)).find(Boolean) ?? "");
}

function isLicense(src: string, region: Region): boolean {
  return bodiesOf(src.slice(region.from, region.to)).some((body) => LICENSE.test(body));
}

function startsAWord(src: string, region: Region): boolean {
  return region.from === 0 || src.charCodeAt(region.from) !== HASH || SHELL_WORD_BOUNDARY.test(src[region.from - 1]);
}

function onConsecutiveLines(src: string, earlier: Region, later: Region): boolean {
  const gap = src.slice(earlier.to, later.from);
  return !gap.trim() && gap.split("\n").length <= 2;
}

function licenseBlocks(src: string, regions: Region[]): Set<Region> {
  const exempt = new Set<Region>();
  let block: Region[] = [];
  const closeBlock = () => {
    if (block.some((region) => isLicense(src, region))) block.forEach((region) => exempt.add(region));
    block = [];
  };
  for (const region of regions) {
    if (block.length && !onConsecutiveLines(src, block[block.length - 1], region)) closeBlock();
    block.push(region);
  }
  closeBlock();
  return exempt;
}

function linesCovered(src: string, regions: Region[]): number[] {
  const lines: number[] = [];
  let line = 1;
  let scanned = 0;
  for (const region of regions) {
    for (; scanned < region.from; scanned++) if (src.charCodeAt(scanned) === NEWLINE) line++;
    const first = line;
    for (; scanned < region.to - 1; scanned++) if (src.charCodeAt(scanned) === NEWLINE) line++;
    const lastListed = lines.length ? lines[lines.length - 1] : 0;
    for (let covered = Math.max(first, lastListed + 1); covered <= line; covered++) lines.push(covered);
  }
  return lines;
}

export function nonExemptCommentLines(src: string, syntax: CommentSyntax): number[] {
  const found: Region[] = [];
  stripCommentsAndStrings(src, STRIP_OPTIONS[syntax], (from, to) => found.push({ from, to }));
  const regions = syntax === "shell" ? found.filter((region) => startsAWord(src, region)) : found;
  const licensed = licenseBlocks(src, regions);
  return linesCovered(src, regions.filter((region) => !licensed.has(region) && !isToolPragma(src, region)));
}
