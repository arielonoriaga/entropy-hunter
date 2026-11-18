import { FREE_NESTING, type EntropyConfig } from "./types";

export class ConfigError extends Error {}

// Fail loudly on garbage config instead of silently producing wrong scores:
// a mistyped section/key, a zero/negative cap, or a negative weight all
// change output with no visible signal today. "make illegal states
// unrepresentable" applies to config as much as to code.
// One error per key of `section` that is not a number > 0.
function nonPositive(name: string, section: Record<string, number>, why = ""): string[] {
  return Object.entries(section)
    .filter(([, value]) => !Number.isFinite(value) || value <= 0)
    .map(([key, value]) => `[${name}] ${key} must be a number > 0 (got ${value})${why}`);
}

const numericGateThresholds = ({ gate }: EntropyConfig): Record<string, number> =>
  Object.fromEntries(
    Object.entries(gate).filter((entry): entry is [string, number] => typeof entry[1] !== "boolean"),
  );

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

  errors.push(
    ...nonPositive("scoring", cfg.scoring, " — a zero/negative cap silently zeroes that signal"),
    ...nonPositive("gate", numericGateThresholds(cfg)),
    ...nonPositive("priority", cfg.priority),
  );

  if (cfg.scoring.nesting_depth_cap <= FREE_NESTING) {
    errors.push(
      `[scoring] nesting_depth_cap must be > ${FREE_NESTING} (got ${cfg.scoring.nesting_depth_cap}) — nesting up to ${FREE_NESTING} deep scores 0`,
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
