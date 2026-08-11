import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { analyzeRepo } from "../src/analyze";
import { computeHealth } from "../src/health";
import { DEFAULT_CONFIG } from "../src/types";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const result = analyzeRepo(FIXTURES, DEFAULT_CONFIG, DEFAULT_CONFIG.analysis.since, null, null);

// A synthetic base result lets each band/rule test control exactly the
// summary/trend/graph values it needs, independent of the fixture repo.
function withOverrides(overrides: Partial<typeof result>) {
  return { ...result, ...overrides };
}

describe("computeHealth — topline bands", () => {
  test("entropy/p95 band thresholds: <30 HEALTHY, 30-69 ATTENTION, >=70 CRITICAL", () => {
    const healthy = computeHealth(withOverrides({ summary: { ...result.summary, entropy: 10, p95_file_entropy: 10 } }));
    expect(healthy.entropy.status).toBe("HEALTHY");
    expect(healthy.entropy.color).toBe("green");

    const attention = computeHealth(withOverrides({ summary: { ...result.summary, entropy: 45, p95_file_entropy: 45 } }));
    expect(attention.entropy.status).toBe("ATTENTION");
    expect(attention.entropy.color).toBe("yellow");

    const critical = computeHealth(withOverrides({ summary: { ...result.summary, entropy: 85, p95_file_entropy: 85 } }));
    expect(critical.entropy.status).toBe("CRITICAL");
    expect(critical.entropy.color).toBe("red");
  });

  test("critical hotspots band: 0 NONE, 1-4 SOME, >=5 HIGH", () => {
    const none = computeHealth(withOverrides({ summary: { ...result.summary, critical_hotspots: 0 } }));
    expect(none.critical.status).toBe("NONE");
    const some = computeHealth(withOverrides({ summary: { ...result.summary, critical_hotspots: 3 } }));
    expect(some.critical.status).toBe("SOME");
    const high = computeHealth(withOverrides({ summary: { ...result.summary, critical_hotspots: 7 } }));
    expect(high.critical.status).toBe("HIGH");
  });

  test("entropy/p95 band exact edges: 29.9 HEALTHY, 30 ATTENTION, 69.9 ATTENTION, 70 CRITICAL", () => {
    const belowAttention = computeHealth(withOverrides({ summary: { ...result.summary, entropy: 29.9, p95_file_entropy: 29.9 } }));
    expect(belowAttention.entropy.status).toBe("HEALTHY");
    expect(belowAttention.p95.status).toBe("HEALTHY");

    const atAttention = computeHealth(withOverrides({ summary: { ...result.summary, entropy: 30, p95_file_entropy: 30 } }));
    expect(atAttention.entropy.status).toBe("ATTENTION");
    expect(atAttention.p95.status).toBe("ATTENTION");

    const belowCritical = computeHealth(withOverrides({ summary: { ...result.summary, entropy: 69.9, p95_file_entropy: 69.9 } }));
    expect(belowCritical.entropy.status).toBe("ATTENTION");
    expect(belowCritical.p95.status).toBe("ATTENTION");

    const atCritical = computeHealth(withOverrides({ summary: { ...result.summary, entropy: 70, p95_file_entropy: 70 } }));
    expect(atCritical.entropy.status).toBe("CRITICAL");
    expect(atCritical.p95.status).toBe("CRITICAL");
  });

  test("critical hotspots exact edges: 1 SOME, 4 SOME, 5 HIGH", () => {
    const atOne = computeHealth(withOverrides({ summary: { ...result.summary, critical_hotspots: 1 } }));
    expect(atOne.critical.status).toBe("SOME");
    const atFour = computeHealth(withOverrides({ summary: { ...result.summary, critical_hotspots: 4 } }));
    expect(atFour.critical.status).toBe("SOME");
    const atFive = computeHealth(withOverrides({ summary: { ...result.summary, critical_hotspots: 5 } }));
    expect(atFive.critical.status).toBe("HIGH");
  });

  test("trend: RISING (delta>0.5) is CRITICAL/red, FALLING/STABLE are green, null is UNKNOWN/gray", () => {
    const rising = computeHealth(withOverrides({ trend: { delta: 2, velocity: null } }));
    expect(rising.trend.status).toBe("RISING");
    expect(rising.trend.color).toBe("red");

    const falling = computeHealth(withOverrides({ trend: { delta: -2, velocity: null } }));
    expect(falling.trend.status).toBe("FALLING");
    expect(falling.trend.color).toBe("green");

    const stable = computeHealth(withOverrides({ trend: { delta: 0, velocity: null } }));
    expect(stable.trend.status).toBe("STABLE");

    const unknown = computeHealth(withOverrides({ trend: { delta: null, velocity: null } }));
    expect(unknown.trend.status).toBe("UNKNOWN");
    expect(unknown.trend.color).toBe("gray");
  });

  test("trend exact edges: delta=0.5 is STABLE (not RISING), delta=-0.5 is STABLE (not FALLING)", () => {
    const atUpperEdge = computeHealth(withOverrides({ trend: { delta: 0.5, velocity: null } }));
    expect(atUpperEdge.trend.status).toBe("STABLE");
    const atLowerEdge = computeHealth(withOverrides({ trend: { delta: -0.5, velocity: null } }));
    expect(atLowerEdge.trend.status).toBe("STABLE");
  });
});

const ZERO_SUMMARY = {
  entropy: 0, complexity: 0, coupling: 0, churn: 0, duplication: 0, state: 0,
  clumping: 0, deadcode: 0, architecture: 0, reach: 0, magic: 0, guard: 0, test: 0,
  p95_file_entropy: 0, critical_hotspots: 0,
};

describe("computeHealth — attention list", () => {
  test("lists only the 12 summary signals scoring >= 30, sorted descending", () => {
    const h = computeHealth(
      withOverrides({ summary: { ...ZERO_SUMMARY, churn: 45, reach: 60, state: 10, complexity: 5 } }),
    );
    const labels = h.attention.map((a) => a.label);
    expect(labels).toEqual(["Reach", "Churn"]); // sorted desc, state/complexity excluded (<30)
  });

  test("exact edge: score of 30 is included, 29.9 is excluded", () => {
    const h = computeHealth(
      withOverrides({ summary: { ...ZERO_SUMMARY, churn: 30, reach: 29.9 } }),
    );
    const labels = h.attention.map((a) => a.label);
    expect(labels).toEqual(["Churn"]);
  });
});

describe("computeHealth — structural list", () => {
  test("cycles/arch_violations are HEALTHY at 0, ATTENTION when present", () => {
    const clean = computeHealth(withOverrides({ cycles: [], architecture_violations: [] }));
    expect(clean.structural.every((s) => s.band === "HEALTHY")).toBe(true);

    const dirty = computeHealth(
      withOverrides({
        cycles: [["a.ts", "b.ts", "a.ts"]],
        architecture_violations: [{ from: "a.ts", to: "b.ts", from_layer: "domain", to_layer: "api" }],
      }),
    );
    expect(dirty.structural.every((s) => s.band === "ATTENTION")).toBe(true);
  });
});

describe("computeHealth — recommendation rules", () => {
  test("no rule fires => empty recommendations", () => {
    const h = computeHealth(
      withOverrides({ summary: { ...result.summary, churn: 0, reach: 0, state: 0 }, cycles: [] }),
    );
    expect(h.recommendations).toEqual([]);
  });

  test("high churn alone triggers 'High-churn modules' only", () => {
    const h = computeHealth(
      withOverrides({ summary: { ...result.summary, churn: 40, reach: 0, state: 0 }, cycles: [] }),
    );
    expect(h.recommendations).toEqual(["High-churn modules"]);
  });

  test("high churn + high reach adds the combo rule", () => {
    const h = computeHealth(
      withOverrides({ summary: { ...result.summary, churn: 40, reach: 40, state: 0 }, cycles: [] }),
    );
    expect(h.recommendations).toEqual(["High-churn modules", "High-reach, high-churn modules"]);
  });

  test("cycles present triggers 'Circular dependencies'", () => {
    const h = computeHealth(
      withOverrides({
        summary: { ...result.summary, churn: 0, reach: 0, state: 0 },
        cycles: [["a.ts", "b.ts", "a.ts"]],
      }),
    );
    expect(h.recommendations).toEqual(["Circular dependencies"]);
  });

  test("high state triggers 'State-heavy domain types'", () => {
    const h = computeHealth(
      withOverrides({ summary: { ...result.summary, churn: 0, reach: 0, state: 40 }, cycles: [] }),
    );
    expect(h.recommendations).toEqual(["State-heavy domain types"]);
  });
});
