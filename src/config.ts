import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { DEFAULT_CONFIG, type EntropyConfig } from "./types";
import { parseToml, toToml } from "./toml";
import { ConfigError, validateConfig } from "./validate";

const KNOWN_SECTIONS = ["entropy", "analysis", "architecture", "hotspots", "scoring"] as const;

export function entropyDir(repo: string): string {
  return join(repo, ".entropy");
}

export function configPath(repo: string): string {
  return join(entropyDir(repo), "config.toml");
}

export function dbPath(repo: string): string {
  return join(entropyDir(repo), "entropy.db");
}

export function initRepo(repo: string): { created: boolean } {
  const dir = entropyDir(repo);
  const cfg = configPath(repo);
  if (existsSync(cfg)) return { created: false };
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    cfg,
    "# entropy-hunter configuration\n" +
      "# All scores are engineering heuristics, not universal measurements.\n" +
      "# *_cap values: the raw value that maps to score 100 (linear, clamped).\n\n" +
      toToml({
        entropy: { ...DEFAULT_CONFIG.entropy },
        analysis: { ...DEFAULT_CONFIG.analysis },
        architecture: { ...DEFAULT_CONFIG.architecture },
        hotspots: { ...DEFAULT_CONFIG.hotspots },
        scoring: { ...DEFAULT_CONFIG.scoring },
      }),
  );
  return { created: true };
}

// Throws ConfigError on a typo'd section/key or an out-of-range value —
// silently ignoring either would change scores with no visible signal.
export function loadConfig(repo: string): EntropyConfig {
  const path = configPath(repo);
  const cfg: EntropyConfig = structuredClone(DEFAULT_CONFIG);
  if (!existsSync(path)) return cfg;
  const toml = parseToml(readFileSync(path, "utf8"));
  const errors: string[] = [];

  for (const section of Object.keys(toml)) {
    if (!(KNOWN_SECTIONS as readonly string[]).includes(section)) {
      errors.push(`unknown section [${section}] — known: ${KNOWN_SECTIONS.join(", ")}`);
    }
  }
  for (const section of KNOWN_SECTIONS) {
    const sec = toml[section];
    if (!sec) continue;
    for (const [k, v] of Object.entries(sec)) {
      if (!(k in cfg[section])) {
        errors.push(`unknown key "${k}" in [${section}]`);
      } else if (typeof v !== typeof (cfg[section] as any)[k]) {
        errors.push(
          `[${section}] ${k} must be a ${typeof (cfg[section] as any)[k]} (got ${JSON.stringify(v)})`,
        );
      } else {
        (cfg[section] as any)[k] = v;
      }
    }
  }
  if (errors.length) {
    throw new ConfigError(`Invalid ${path}:\n  - ${errors.join("\n  - ")}`);
  }

  validateConfig(cfg);
  return cfg;
}
