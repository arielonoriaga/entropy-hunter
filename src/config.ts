import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { DEFAULT_CONFIG, type EntropyConfig } from "./types";
import { parseToml, toToml } from "./toml";

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

export function loadConfig(repo: string): EntropyConfig {
  const path = configPath(repo);
  const cfg: EntropyConfig = structuredClone(DEFAULT_CONFIG);
  if (!existsSync(path)) return cfg;
  const toml = parseToml(readFileSync(path, "utf8"));
  for (const section of ["entropy", "analysis", "architecture", "hotspots", "scoring"] as const) {
    const sec = toml[section];
    if (!sec) continue;
    for (const [k, v] of Object.entries(sec)) {
      if (k in cfg[section] && typeof v === typeof (cfg[section] as any)[k]) {
        (cfg[section] as any)[k] = v;
      }
    }
  }
  return cfg;
}
