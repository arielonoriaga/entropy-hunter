import { describe, expect, test } from "bun:test";
import { analyzeRepo } from "../src/analyze";
import { renderAnalysis, renderFile, renderHistory, renderHotspots, renderMarkdown, trendLabel } from "../src/report";
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
    expect(text).toContain(`Files analyzed: ${result.files_analyzed}`);
  });

  test("mentions cycles and architecture violations when present", () => {
    const text = renderAnalysis(result);
    if (result.cycles.length) expect(text).toContain("Circular dependencies");
    if (result.architecture_violations.length) expect(text).toContain("Architecture violations");
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
});

describe("renderMarkdown", () => {
  test("produces a markdown table with the entropy index and hotspots", () => {
    const md = renderMarkdown(result);
    expect(md).toContain("# Entropy Report");
    expect(md).toContain("**Entropy Index**");
    expect(md).toContain("## Hotspots");
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
