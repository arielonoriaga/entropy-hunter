#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeRepo } from "./analyze";
import { configPath, dbPath, initRepo, loadConfig } from "./config";
import { sinceToDate } from "./git";
import { renderAnalysis, renderFile, renderHistory, renderHotspots, renderMarkdown } from "./report";
import { Storage, withDeltas } from "./storage";
import type { AnalysisResult } from "./types";

const USAGE = `entropy — deterministic software-entropy analyzer (Rust + TS/JS)

Usage: entropy <command> [options]

Commands:
  init                    Create .entropy/ (config.toml + entropy.db)
  analyze                 Analyze the working tree
  snapshot                Analyze and persist a snapshot for the current commit
  history                 Show entropy across snapshots
  hotspots                Show highest-risk files
  file <path>             Show metrics for one file
  report                  Full report (--format text|json|markdown)

Options:
  --repo <path>           Repository to analyze (default: cwd)
  --since <window>        Churn window, e.g. 30d, 12w, 6m (default: config)
  --limit <n>             Row limit for history/hotspots
  --language <lang>       Filter hotspots: rust | typescript
  --format <fmt>          Report format: text | json | markdown
  --force                 Allow duplicate snapshot for the same commit
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
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "",
    positional: [],
    repo: process.cwd(),
    format: "text",
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = resolve(argv[++i] ?? ".");
    else if (a === "--since") args.since = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--language") args.language = argv[++i];
    else if (a === "--format") args.format = argv[++i] ?? "text";
    else if (a === "--force") args.force = true;
    else if (a === "--help" || a === "-h") args.command ||= "help";
    else if (!args.command) args.command = a;
    else args.positional.push(a);
  }
  return args;
}

function analyzeWithTrend(args: Args): AnalysisResult {
  const config = loadConfig(args.repo);
  // Initialized repos get the incremental cache; otherwise run stateless.
  const storage = existsSync(dbPath(args.repo)) ? new Storage(dbPath(args.repo)) : null;
  const result = analyzeRepo(args.repo, config, args.since ?? config.analysis.since, storage);
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = () => loadConfig(args.repo);

  switch (args.command) {
    case "init": {
      const { created } = initRepo(args.repo);
      console.log(
        created
          ? `Initialized ${configPath(args.repo)}`
          : `Already initialized: ${configPath(args.repo)}`,
      );
      break;
    }

    case "analyze": {
      console.log(renderAnalysis(analyzeWithTrend(args)));
      break;
    }

    case "snapshot": {
      const result = analyzeWithTrend(args);
      const storage = new Storage(dbPath(args.repo));
      if (!args.force && storage.hasSnapshotFor(result.repository.commit)) {
        console.log(
          `Snapshot for commit ${result.repository.commit} already exists (use --force to add another).`,
        );
        storage.close();
        break;
      }
      const id = storage.saveSnapshot(result);
      storage.close();
      console.log(
        `Snapshot #${id} saved — commit ${result.repository.commit}, entropy ${result.summary.entropy.toFixed(1)}`,
      );
      break;
    }

    case "history": {
      const storage = new Storage(dbPath(args.repo));
      const rows = storage.history({
        limit: args.limit,
        sinceDate: args.since ? sinceToDate(args.since) : undefined,
      });
      storage.close();
      console.log(renderHistory(rows));
      break;
    }

    case "hotspots": {
      const result = analyzeWithTrend(args);
      let pool = result.files;
      if (args.language) pool = pool.filter((f) => f.language === args.language);
      const sorted = [...pool].sort(
        (a, b) => b.hotspot_score - a.hotspot_score || a.path.localeCompare(b.path),
      );
      console.log(renderHotspots(sorted, args.limit ?? config().hotspots.limit));
      break;
    }

    case "file": {
      const target = args.positional[0];
      if (!target) {
        console.error("Usage: entropy file <path>");
        process.exit(1);
      }
      const result = analyzeWithTrend(args);
      const norm = target.replace(/^\.\//, "");
      const f = result.files.find((x) => x.path === norm);
      if (!f) {
        console.error(`Not an analyzed file: ${norm}`);
        process.exit(1);
      }
      console.log(renderFile(f));
      break;
    }

    case "report": {
      const result = analyzeWithTrend(args);
      if (args.format === "json") {
        // Stable machine-readable schema (version field inside).
        console.log(JSON.stringify(result, null, 2));
      } else if (args.format === "markdown") {
        console.log(renderMarkdown(result));
      } else {
        console.log(renderAnalysis(result));
        console.log("\n" + renderHotspots(result.hotspots, config().hotspots.limit));
        if (existsSync(dbPath(args.repo))) {
          const storage = new Storage(dbPath(args.repo));
          const rows = withDeltas(storage.history({ limit: 10 }));
          storage.close();
          if (rows.length) console.log("\n" + renderHistory(rows));
        }
      }
      break;
    }

    case "help":
    case "":
      console.log(USAGE);
      break;

    default:
      console.error(`Unknown command: ${args.command}\n\n${USAGE}`);
      process.exit(1);
  }
}

main();
