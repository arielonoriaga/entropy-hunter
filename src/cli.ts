#!/usr/bin/env bun
import { existsSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeRepo } from "./analyze";
import { openCache } from "./cache";
import { CheckError, checkRepo, recordWaiver } from "./check";
import { configPath, dbPath, initRepo, loadConfig } from "./config";
import { GitError, sinceToDate } from "./git";
import {
  renderAnalysis, renderCheck, renderFile, renderHealth, renderHealthMarkdown, renderHistory,
  renderHotspots, renderMarkdown, renderModules, renderPriority, renderZoom,
} from "./report";
import { computeHealth } from "./health";
import { Storage, withDeltas } from "./storage";
import type { AnalysisResult, FileMetrics } from "./types";
import { ConfigError } from "./validate";
import { moduleRollups, zoom } from "./zoom";

const FORMATS = new Set(["text", "json", "markdown"]);
class CliError extends Error {}

const USAGE = `entropy — deterministic software-entropy analyzer (Rust + TS/JS)

Usage: entropy <command> [options]

Commands:
  init                    Create .entropy/ (config.toml + entropy.db)
  analyze                 Analyze the working tree
  snapshot                Analyze and persist a snapshot for the current commit
  history                 Show entropy across snapshots
  hotspots                Show highest-risk files (complexity/coupling/churn)
  priority                Show most dangerous files to refactor (entropy × reach)
  health                  Executive summary: HEALTHY/ATTENTION bands + recommendations
  file <path>             Show metrics for one file
  zoom [path]             Zoom out: module rollups, or the ladder file → module → repo
                          for one path, with where the cause lives at each level
  check                   Gate: did the changed files get worse than at the base
                          commit? Exit 1 on a regression
  report                  Full report (--format text|json|markdown)

Options:
  --repo <path>           Repository to analyze (default: cwd)
  --since <window>        Churn window, e.g. 30d, 12w, 6m (default: config)
  --limit <n>             Row limit for history/hotspots/priority
  --language <lang>       Filter hotspots/priority: rust | typescript
  --format <fmt>          Output format for report|file|hotspots|priority|health|zoom|check:
                          text | json | markdown
  --force                 Allow duplicate snapshot for the same commit
  --base <ref>            check: commit to compare against (default: auto — the
                          upstream branch, else the remote default branch, else HEAD)
  --files <a,b,…>         check: only judge these changed files
  --touched-since <time>  check: only judge files modified since then (epoch
                          seconds or ISO timestamp) — e.g. a work session's start
  --accept <path>         check: accept a failing file as it is now (needs --reason);
                          any later edit to it is judged again
  --reason <text>         check: why the accepted regression is legitimate
`;

interface Args {
  command: string;
  positional: string[];
  repo: string;
  since?: string;
  limit?: number;
  language?: string;
  format: string;
  force: boolean;
  base: string;
  files: string[] | null;
  accept?: string;
  reason?: string;
  touchedSince: number | null;
}

// Each flag consumes its value (undefined when the flag is last) and writes
// it onto Args. Throws CliError on a malformed value instead of silently
// misbehaving — `--limit abc` used to become `slice(0, NaN)` (empty output,
// no error) and `--limit -5` was accepted outright.
const VALUE_FLAGS: Record<string, (args: Args, value: string | undefined) => void> = {
  "--repo": (args, value) => (args.repo = resolve(value ?? ".")),
  "--since": (args, value) => (args.since = value),
  "--language": (args, value) => (args.language = value),
  "--base": (args, value) => (args.base = value ?? "auto"),
  "--accept": (args, value) => (args.accept = value),
  "--reason": (args, value) => (args.reason = value),
  "--files": (args, value) =>
    (args.files = (value ?? "").split(",").map((f) => f.trim()).filter(Boolean)),
  "--touched-since": (args, value) => {
    // Epoch seconds, or anything Date parses (an ISO timestamp).
    const ms = /^\d+(\.\d+)?$/.test(value ?? "") ? Number(value) * 1000 : Date.parse(value ?? "");
    if (Number.isNaN(ms)) {
      throw new CliError(`--touched-since must be epoch seconds or an ISO timestamp (got "${value}")`);
    }
    args.touchedSince = ms;
  },
  "--limit": (args, value) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
      throw new CliError(`--limit must be a positive integer (got "${value}")`);
    }
    args.limit = n;
  },
  "--format": (args, value = "text") => {
    if (!FORMATS.has(value)) {
      throw new CliError(`--format must be one of ${[...FORMATS].join("|")} (got "${value}")`);
    }
    args.format = value;
  },
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "",
    positional: [],
    repo: process.cwd(),
    format: "text",
    force: false,
    base: "auto",
    files: null,
    touchedSince: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (Object.hasOwn(VALUE_FLAGS, a)) VALUE_FLAGS[a](args, argv[++i]);
    else if (a === "--force") args.force = true;
    else if (a === "--help" || a === "-h") args.command ||= "help";
    else if (!args.command) args.command = a;
    else args.positional.push(a);
  }
  return args;
}

// Results go to stdout synchronously. `console.log` on a pipe is
// asynchronous once anything has touched `process.stdout` (picocolors does,
// at import), and the process then exits with the tail unwritten: a report
// piped to `jq` was cut at the 64 KiB pipe buffer.
const RETRY_PAUSE = new Int32Array(new SharedArrayBuffer(4));
function emit(text: string): void {
  const data = Buffer.from(text + "\n");
  let offset = 0;
  while (offset < data.length) {
    try {
      offset += writeSync(1, data, offset);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPIPE") return; // reader went away (`| head`): nothing left to say
      if (code !== "EAGAIN") throw err;
      Atomics.wait(RETRY_PAUSE, 0, 0, 2); // non-blocking pipe is full: let the reader drain
    }
  }
}

// One of three renderings of the same value, by --format.
function emitAs<T>(args: Args, value: T, text: (v: T) => string, markdown: (v: T) => string = text) {
  if (args.format === "json") emit(JSON.stringify(value, null, 2));
  else emit(args.format === "markdown" ? markdown(value) : text(value));
}

// Live progress on stderr, only when a human is watching (TTY). Piped or
// agent-driven runs stay silent so stdout/stderr remain machine-clean.
const progress = process.stderr.isTTY
  ? (msg: string) => process.stderr.write(`\r\x1b[K⏳ ${msg}`)
  : null;
const clearProgress = () => {
  if (progress) process.stderr.write("\r\x1b[K");
};

function analyzeWithTrend(args: Args): AnalysisResult {
  const config = loadConfig(args.repo);
  const cache = openCache(args.repo);
  const result = analyzeRepo(
    args.repo, config, args.since ?? config.analysis.since, cache, progress,
  );
  cache?.close();
  clearProgress();
  // Trend needs history, which only an initialized repo with snapshots has.
  const storage = existsSync(dbPath(args.repo)) ? new Storage(dbPath(args.repo)) : null;
  const prev = storage?.latest();
  if (prev) {
    const delta = Math.round((result.summary.entropy - prev.entropy) * 10) / 10;
    const days =
      (new Date(result.timestamp).getTime() - new Date(prev.timestamp).getTime()) / 86400_000;
    result.trend = {
      delta,
      velocity: days > 0 ? Math.round((delta / days) * 100) / 100 : null,
    };
  }
  storage?.close();
  return result;
}

// Shared by hotspots/priority: rank files by one score, filter by
// --language, apply --limit, then render as json or the given text/markdown
// renderer.
function runRanked(
  args: Args,
  scoreOf: (f: FileMetrics) => number,
  render: (sorted: FileMetrics[], limit: number) => string,
) {
  const result = analyzeWithTrend(args);
  let pool = result.files;
  if (args.language) pool = pool.filter((f) => f.language === args.language);
  const sorted = [...pool].sort((a, b) => scoreOf(b) - scoreOf(a) || a.path.localeCompare(b.path));
  const limit = args.limit ?? loadConfig(args.repo).hotspots.limit;
  if (args.format === "json") emit(JSON.stringify(sorted.slice(0, limit), null, 2));
  else emit(render(sorted, limit));
}

const withoutDotSlash = (path: string) => path.replace(/^\.\//, "");

// Exit code 1: the command ran but has nothing valid to show for this input.
class Failure extends Error {}

function fullTextReport(args: Args, result: AnalysisResult): string {
  const limit = loadConfig(args.repo).hotspots.limit;
  const sections = [
    renderAnalysis(result),
    renderHealth(computeHealth(result)),
    renderHotspots(result.hotspots, limit),
    renderPriority(result.priority, limit),
  ];
  if (existsSync(dbPath(args.repo))) {
    const storage = new Storage(dbPath(args.repo));
    const rows = withDeltas(storage.history({ limit: 10 }));
    storage.close();
    if (rows.length) sections.push(renderHistory(rows));
  }
  return sections.join("\n\n");
}

const COMMANDS: Record<string, (args: Args) => void> = {
  init(args) {
    const { created } = initRepo(args.repo);
    emit(
      created
        ? `Initialized ${configPath(args.repo)}`
        : `Already initialized: ${configPath(args.repo)}`,
    );
  },

  analyze(args) {
    const result = analyzeWithTrend(args);
    emit(renderAnalysis(result));
    emit("\n" + renderHealth(computeHealth(result)));
  },

  snapshot(args) {
    const result = analyzeWithTrend(args);
    const storage = new Storage(dbPath(args.repo));
    const duplicate = !args.force && storage.hasSnapshotFor(result.repository.commit);
    const id = duplicate ? null : storage.saveSnapshot(result);
    storage.close();
    emit(
      id === null
        ? `Snapshot for commit ${result.repository.commit} already exists (use --force to add another).`
        : `Snapshot #${id} saved — commit ${result.repository.commit}, entropy ${result.summary.entropy.toFixed(1)}`,
    );
  },

  history(args) {
    const storage = new Storage(dbPath(args.repo));
    const rows = storage.history({
      limit: args.limit,
      sinceDate: args.since ? sinceToDate(args.since) : undefined,
    });
    storage.close();
    emit(renderHistory(rows));
  },

  hotspots: (args) => runRanked(args, (f) => f.hotspot_score, renderHotspots),
  priority: (args) => runRanked(args, (f) => f.priority_score, renderPriority),

  health(args) {
    emitAs(args, computeHealth(analyzeWithTrend(args)), renderHealth, renderHealthMarkdown);
  },

  file(args) {
    const target = args.positional[0];
    if (!target) throw new Failure("Usage: entropy file <path>");
    const path = withoutDotSlash(target);
    const file = analyzeWithTrend(args).files.find((x) => x.path === path);
    if (!file) throw new Failure(`Not an analyzed file: ${path}`);
    emitAs(args, file, renderFile);
  },

  zoom(args) {
    const result = analyzeWithTrend(args);
    const target = args.positional[0];
    if (!target) {
      const limit = args.limit ?? loadConfig(args.repo).hotspots.limit;
      emitAs(args, moduleRollups(result).slice(0, limit), (modules) => renderModules(modules, limit));
      return;
    }
    const ladder = zoom(result, target);
    if (!ladder) throw new Failure(`Not an analyzed file or directory: ${target}`);
    emitAs(args, ladder, renderZoom);
  },

  check(args) {
    const cache = openCache(args.repo);
    if (args.accept) {
      if (!args.reason?.trim()) throw new CliError('--accept needs --reason "<why this regression is legitimate>"');
      if (!cache) throw new CliError("cannot record a waiver: the cache is disabled or not writable");
      recordWaiver(cache, args.repo, withoutDotSlash(args.accept), args.reason.trim());
    }
    const config = loadConfig(args.repo);
    const result = checkRepo(
      args.repo, config,
      {
        base: args.base, since: args.since ?? config.analysis.since,
        only: args.files, touchedSince: args.touchedSince,
      },
      cache, progress,
    );
    cache?.close();
    clearProgress();
    emitAs(args, result, renderCheck);
    if (result.verdict === "fail") process.exitCode = 1;
  },

  report(args) {
    const result = analyzeWithTrend(args);
    // JSON is the stable machine-readable schema (version field inside).
    emitAs(
      args, result,
      (r) => fullTextReport(args, r),
      (r) => renderMarkdown(r, computeHealth(r)),
    );
  },

  help: () => emit(USAGE),
};

// Error class → exit code. Anything else is genuinely unexpected: keep the stack.
function exitCodeFor(err: unknown): number | null {
  if (err instanceof Failure) return 1;
  const expected = [ConfigError, GitError, CliError, CheckError];
  return expected.some((kind) => err instanceof kind) ? 2 : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const name = args.command || "help";
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
  if (!command) throw new Failure(`Unknown command: ${args.command}\n\n${USAGE}`);
  command(args);
}

try {
  main();
} catch (err) {
  const code = exitCodeFor(err);
  if (code === null) throw err;
  const message = (err as Error).message;
  console.error(err instanceof Failure ? message : `Error: ${message}`);
  process.exitCode = code;
}
