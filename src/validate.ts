import type { EntropyConfig } from "./types";

export class ConfigError extends Error {}

// Fail loudly on garbage config instead of silently producing wrong scores:
// a mistyped section/key, a zero/negative cap, or a negative weight all
// change output with no visible signal today. "make illegal states
// unrepresentable" applies to config as much as to code.
export function validateConfig(cfg: EntropyConfig): void {
  const errors: string[] = [];

  const weightGroups: [string, Record<string, number>][] = [
    ["entropy", cfg.entropy as unknown as Record<string, number>],
    ["hotspots", cfg.hotspots as unknown as Record<string, number>],
  ];
  for (const [group, weights] of weightGroups) {
    let sum = 0;
    for (const [key, value] of Object.entries(weights)) {
      if (!Number.isFinite(value) || value < 0) {
        errors.push(`[${group}] ${key} must be a number >= 0 (got ${value})`);
      } else {
        sum += value;
      }
    }
    if (sum <= 0) errors.push(`[${group}] weights must sum to > 0 (got ${sum})`);
  }

  for (const [key, value] of Object.entries(cfg.scoring)) {
    if (!Number.isFinite(value) || value <= 0) {
      errors.push(`[scoring] ${key} must be a number > 0 (got ${value}) — a zero/negative cap silently zeroes that signal`);
    }
  }

  if (!Number.isFinite(cfg.priority.critical_threshold) || cfg.priority.critical_threshold <= 0) {
    errors.push(
      `[priority] critical_threshold must be a number > 0 (got ${cfg.priority.critical_threshold})`,
    );
  }

  const layers = cfg.architecture.layers.split(",").map((l) => l.trim()).filter(Boolean);
  if (new Set(layers).size !== layers.length) {
    errors.push(`[architecture] layers contains duplicate names: "${cfg.architecture.layers}"`);
  }

  if (!/^\d+[dwmy]$|^\d{4}-\d{2}-\d{2}/.test(cfg.analysis.since)) {
    errors.push(`[analysis] since must look like "30d"/"12w"/"6m"/"1y" or "YYYY-MM-DD" (got "${cfg.analysis.since}")`);
  }

  if (errors.length) {
    throw new ConfigError(`Invalid configuration:\n  - ${errors.join("\n  - ")}`);
  }
}
