import { describe, expect, test } from "bun:test";
import { analyzeRepo } from "../src/analyze";
import {
  renderAnalysis, renderFile, renderHealth, renderHealthMarkdown, renderHistory, renderHotspots,
  renderMarkdown, renderPriority, trendLabel,
} from "../src/report";
import { computeHealth } from "../src/health";
import { withDeltas } from "../src/storage";
import { DEFAULT_CONFIG } from "../src/types";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const result = analyzeRepo(FIXTURES, DEFAULT_CONFIG, DEFAULT_CONFIG.analysis.since, null, null);

describe("trendLabel", () => {
  test("null delta is UNKNOWN, otherwise RISING/FALLING/STABLE by threshold", () => {
    expect(trendLabel(null)).toBe("UNKNOWN");
    expect(trendLabel(2)).toBe("RISING (+2.0)");
    expect(trendLabel(-2)).toBe("FALLING (-2.0)");
    expect(trendLabel(0.1)).toBe("STABLE (+0.1)");
  });
});

describe("renderAnalysis", () => {
  test("includes repository, summary scores and entropy index", () => {
    const text = renderAnalysis(result);
    expect(text).toContain(result.repository.name);
    expect(text).toContain(result.repository.commit);
    expect(text).toContain("Entropy Index:");
    expect(text).toContain("P95 File Entropy:");
    expect(text).toContain("Critical Hotspots:");
    expect(text).toContain(`Files analyzed: ${result.files_analyzed}`);
  });

  test("mentions cycles and architecture violations when present", () => {
    const text = renderAnalysis(result);
    if (result.cycles.length) expect(text).toContain("Circular dependencies");
    if (result.architecture_violations.length) expect(text).toContain("Architecture violations");
  });

  test("includes the Semantic summary line", () => {
    const text = renderAnalysis(result);
    expect(text).toContain("Semantic:");
  });
});

describe("renderHotspots", () => {
  test("numbers rows and includes each hotspot's why-string", () => {
    const text = renderHotspots(result.hotspots, 3);
    if (result.hotspots.length) {
      expect(text).toContain("1. " + result.hotspots[0].path);
      expect(text).toContain(result.hotspots[0].why);
    }
  });

  test("empty hotspot list still renders a valid, non-empty report", () => {
    const text = renderHotspots([], 5);
    expect(text).toContain("HOTSPOTS");
    expect(text.length).toBeGreaterThan(0);
  });
});

describe("renderPriority", () => {
  test("boxes rows with a color dot and rounded score, sorted by priority_score desc", () => {
    const text = renderPriority(result.priority, 3);
    expect(text).toContain("REFACTOR PRIORITY");
    if (result.priority.length) {
      expect(text).toContain(result.priority[0].path);
    }
  });

  test("empty priority list still renders a valid, non-empty report", () => {
    const text = renderPriority([], 5);
    expect(text).toContain("REFACTOR PRIORITY");
    expect(text.length).toBeGreaterThan(0);
  });

  test("dot bucket is chosen from the exact (unrounded) priority_score, at each threshold boundary", () => {
    const base = result.files[0];
    // Bucket thresholds are inclusive at 70/50/30 (score >= min), independent
    // of the displayed Math.round(priority_score) — a mutation flipping >=
    // to > at any threshold silently reclassifies every boundary file.
    const cases: Array<[number, string]> = [
      [70, "🔴"], [69.99, "🟠"],
      [50, "🟠"], [49.99, "🟡"],
      [30, "🟡"], [29.99, "🟢"],
      [0, "🟢"],
    ];
    for (const [score, dot] of cases) {
      const file = { ...base, path: `boundary/${score}.ts`, priority_score: score };
      const text = renderPriority([file], 1);
      expect(text).toContain(dot);
    }
  });

  test("rounding can put a displayed score of 70 in the orange (not red) bucket", () => {
    // priority_score 69.6 rounds to 70 for display, but the dot bucket reads
    // the raw score, so it lands one bucket below what the number implies.
    const file = { ...result.files[0], path: "boundary/69.6.ts", priority_score: 69.6 };
    const text = renderPriority([file], 1);
    expect(text).toContain("🟠");
    expect(text).toContain(" 70");
  });
});

describe("renderHealth", () => {
  const health = computeHealth(result);

  test("includes the four topline bands and a recommendation section", () => {
    const text = renderHealth(health);
    expect(text).toContain("REPOSITORY HEALTH");
    expect(text).toContain("Entropy");
    expect(text).toContain("Trend");
    expect(text).toContain("Recommendation:");
  });

  test("says 'No broad refactoring recommended' when no rule fires", () => {
    const clean = computeHealth({
      ...result,
      summary: { ...result.summary, churn: 0, reach: 0, state: 0 },
      cycles: [],
    });
    expect(renderHealth(clean)).toContain("No broad refactoring recommended.");
  });

  test("markdown variant renders the same status bands as a table", () => {
    const md = renderHealthMarkdown(health);
    expect(md).toContain("## Repository Health");
    expect(md).toContain("| Entropy |");
    expect(md).toContain("**Recommendation**");
  });
});

describe("renderFile", () => {
  test("includes complexity, coupling, churn, test coverage and hotspot score", () => {
    const f = result.files.find((x) => x.path === "typescript/tested/math.ts")!;
    const text = renderFile(f);
    expect(text).toContain(f.path);
    expect(text).toContain(`total: ${f.complexity_total}`);
    expect(text).toContain(`fan-in: ${f.fan_in}`);
    expect(text).toContain("covered (" + f.test_path + ")");
    expect(text).toContain(`Hotspot score: ${Math.round(f.hotspot_score)}`);
  });

  test("an untested file says so explicitly", () => {
    const f = result.files.find((x) => x.path === "typescript/complex/logic.ts")!;
    expect(renderFile(f)).toContain("NO TEST FOUND");
  });

  test("shows the Semantic ambiguity section when nested optionality is present", () => {
    const nested = result.files.find((f) => f.path === "rust/nested-optionality/src/lib.rs")!;
    const text = renderFile(nested);
    expect(text).toContain("Semantic ambiguity");
    expect(text).toMatch(/worst depth: 2/);
  });

  test("public-struct note is independent of worst depth: fixture's worst depth (2) is a PRIVATE struct (InternalCache), while a DIFFERENT, shallower struct (UpdateUser, depth 1) is public — the note must not be attached to the worst-depth line as if the depth-2 field itself were public", () => {
    const nested = result.files.find((f) => f.path === "rust/nested-optionality/src/lib.rs")!;
    expect(nested.max_optional_depth).toBe(2);
    expect(nested.nested_optional_pub).toBe(true);
    const text = renderFile(nested);
    // "worst depth" line must not carry the public-struct suffix.
    const worstDepthLine = text.split("\n").find((l) => l.includes("worst depth"))!;
    expect(worstDepthLine).not.toContain("public");
    // The public-struct note appears as its own line elsewhere in the section.
    expect(text).toContain("nested optionality also appears in a public struct");
  });
});

describe("renderMarkdown", () => {
  test("produces a markdown table with the entropy index and hotspots", () => {
    const md = renderMarkdown(result, computeHealth(result));
    expect(md).toContain("# Entropy Report");
    expect(md).toContain("**Entropy Index**");
    expect(md).toContain("P95 File Entropy");
    expect(md).toContain("Critical Hotspots");
    expect(md).toContain("## Repository Health");
    expect(md).toContain("## Hotspots");
    expect(md).toContain("## Refactor Priority");
  });
});

describe("renderHistory", () => {
  test("no snapshots yet prints a hint instead of an empty table", () => {
    expect(renderHistory([])).toContain("entropy snapshot");
  });

  test("renders DATE/COMMIT/ENTROPY/DELTA columns with deltas applied", () => {
    const rows = withDeltas([
      { id: 1, repository: "r", commit_hash: "aaa1111", timestamp: "2026-07-01T00:00:00.000Z", entropy: 40, complexity: 0, coupling: 0, churn: 0, duplication: 0, files_analyzed: 1 },
      { id: 2, repository: "r", commit_hash: "bbb2222", timestamp: "2026-07-11T00:00:00.000Z", entropy: 45, complexity: 0, coupling: 0, churn: 0, duplication: 0, files_analyzed: 1 },
    ]);
    const text = renderHistory(rows);
    expect(text).toContain("aaa1111");
    expect(text).toContain("bbb2222");
    expect(text).toContain("+5.0");
  });
});
