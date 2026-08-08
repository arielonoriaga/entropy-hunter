import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { analyzeRepo, findCycles, normalize } from "../src/analyze";
import { detectDuplication, fingerprint, WINDOW } from "../src/duplication";
import { DEFAULT_CONFIG } from "../src/types";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

describe("normalization", () => {
  test("linear and clamped to 0-100", () => {
    expect(normalize(0, 10)).toBe(0);
    expect(normalize(5, 10)).toBe(50);
    expect(normalize(10, 10)).toBe(100);
    expect(normalize(50, 10)).toBe(100);
    expect(normalize(5, 0)).toBe(0);
  });
});

describe("duplication", () => {
  test("identical blocks across files are detected", () => {
    const block = Array.from({ length: WINDOW }, (_, i) => `statement number ${i};`);
    const files = new Map([
      ["a.ts", fingerprint([...block, "unique to a;"])],
      ["b.ts", fingerprint(["unique to b;", ...block])],
      ["c.ts", fingerprint(["nothing shared here;", "at all really;"])],
    ]);
    const result = detectDuplication(files);
    expect(result.get("a.ts")!.duplicated_lines).toBe(WINDOW);
    expect(result.get("a.ts")!.duplicated_blocks).toBe(1);
    expect(result.get("b.ts")!.duplicated_lines).toBe(WINDOW);
    expect(result.get("c.ts")!.duplicated_lines).toBe(0);
    expect(result.get("a.ts")!.duplication_percentage).toBeCloseTo((WINDOW / (WINDOW + 1)) * 100);
  });

  test("no false positives below window size", () => {
    const short = fingerprint(["one shared line;"]);
    const result = detectDuplication(new Map([["a.ts", short], ["b.ts", short]]));
    expect(result.get("a.ts")!.duplicated_lines).toBe(0);
  });
});

describe("cycle detection", () => {
  test("finds the orders<->payments cycle", () => {
    const graph = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
      ["c", ["a"]],
    ]);
    const cycles = findCycles(graph);
    expect(cycles.length).toBe(1);
    expect(new Set(cycles[0])).toEqual(new Set(["a", "b"]));
  });

  test("acyclic graph yields none", () => {
    expect(findCycles(new Map([["a", ["b"]], ["b", []]]))).toEqual([]);
  });
});

describe("analyzeRepo on fixtures", () => {
  const result = analyzeRepo(FIXTURES, DEFAULT_CONFIG, DEFAULT_CONFIG.analysis.since, null, null);

  test("finds both languages", () => {
    expect(result.files_by_language.rust).toBe(7);
    expect(result.files_by_language.typescript).toBe(6);
    expect(result.files_analyzed).toBe(13);
  });

  test("state signal: optional-soup types score high, clean files zero", () => {
    const rusty = result.files.find((f) => f.path === "rust/stateful/src/lib.rs")!;
    expect(rusty.max_state_fields).toBe(6);
    expect(rusty.state_score).toBe(100); // 6 fields at default cap 6
    const clean = result.files.find((f) => f.path === "rust/simple/src/lib.rs")!;
    expect(clean.state_score).toBe(0);
  });

  test("clumping signal: order_* data clump detected and scored", () => {
    const rusty = result.files.find((f) => f.path === "rust/stateful/src/lib.rs")!;
    expect(rusty.data_clumps).toBe(1);
    expect(rusty.max_clump_fields).toBe(3);
    expect(rusty.clump_prefix).toBe("order");
    expect(rusty.clumping_score).toBe(50); // 3 fields at default cap 6
    const clean = result.files.find((f) => f.path === "typescript/simple/util.ts")!;
    expect(clean.clumping_score).toBe(0);
  });

  test("coupling: fan_in/fan_out are consistent", () => {
    const shared = result.files.find((f) => f.path === "rust/coupled/src/shared.rs")!;
    expect(shared.fan_in).toBe(3); // main, orders, payments
    expect(shared.fan_out).toBe(0);
    const orders = result.files.find((f) => f.path === "typescript/coupled/orders.ts")!;
    expect(orders.fan_out).toBe(2);
    expect(orders.fan_in).toBe(1); // payments (cycle)
    // graph-wide invariant: total fan_in == total fan_out
    const totalIn = result.files.reduce((s, f) => s + f.fan_in, 0);
    const totalOut = result.files.reduce((s, f) => s + f.fan_out, 0);
    expect(totalIn).toBe(totalOut);
  });

  test("detects circular dependencies in both languages", () => {
    const flat = result.cycles.flat().join(" ");
    expect(flat).toContain("orders.ts");
    expect(flat).toContain("orders.rs");
  });

  test("entropy index is the weight-sum-normalized combination of summary scores", () => {
    const { summary } = result;
    const w = DEFAULT_CONFIG.entropy;
    const wsum =
      w.complexity_weight + w.coupling_weight + w.churn_weight +
      w.duplication_weight + w.state_weight + w.clumping_weight;
    const expected =
      (summary.complexity * w.complexity_weight +
        summary.coupling * w.coupling_weight +
        summary.churn * w.churn_weight +
        summary.duplication * w.duplication_weight +
        summary.state * w.state_weight +
        summary.clumping * w.clumping_weight) / wsum;
    expect(summary.entropy).toBeCloseTo(expected, 1);
    expect(summary.entropy).toBeGreaterThanOrEqual(0);
    expect(summary.entropy).toBeLessThanOrEqual(100);
  });

  test("hotspot ranking uses configured weights and sorts descending", () => {
    const w = DEFAULT_CONFIG.hotspots;
    for (const h of result.hotspots) {
      expect(h.hotspot_score).toBeCloseTo(
        h.complexity_score * w.complexity_weight +
          h.coupling_score * w.coupling_weight +
          h.churn_score * w.churn_weight,
        0, // hotspot_score is rounded to 1 decimal after weighting
      );
    }
    const scores = result.hotspots.map((h) => h.hotspot_score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  test("per-file entropy contributions sum to the global index", () => {
    const sum = result.files.reduce((s, f) => s + f.entropy_contribution, 0);
    expect(sum).toBeCloseTo(result.summary.entropy, 0);
  });

  test("JSON schema shape (version 3)", () => {
    expect(result.version).toBe(3);
    expect(result.repository).toHaveProperty("name");
    expect(result.repository).toHaveProperty("commit");
    for (const k of ["entropy", "complexity", "coupling", "churn", "duplication", "state", "clumping"]) {
      expect(typeof (result.summary as any)[k]).toBe("number");
    }
    expect(Array.isArray(result.files)).toBe(true);
    expect(Array.isArray(result.hotspots)).toBe(true);
    expect(result.trend).toHaveProperty("delta");
    expect(result.trend).toHaveProperty("velocity");
    const f = result.files[0];
    for (const k of [
      "loc", "complexity_total", "complexity_average", "complexity_max",
      "fan_in", "fan_out", "dependency_count", "dependent_count",
      "commits", "lines_added", "lines_deleted", "lines_changed",
      "duplicated_lines", "duplicated_blocks", "duplication_percentage",
      "complexity_score", "coupling_score", "churn_score",
      "duplication_score", "state_score", "clumping_score", "hotspot_score",
      "entropy_contribution", "type_count", "optional_fields", "boolean_fields",
      "max_state_fields", "data_clumps", "max_clump_fields",
    ]) {
      expect(typeof (f as any)[k]).toBe("number");
    }
  });

  test("deterministic: analyzing twice yields identical metrics", () => {
    const again = analyzeRepo(FIXTURES, DEFAULT_CONFIG, DEFAULT_CONFIG.analysis.since, null, null);
    const strip = (r: typeof result) => ({ ...r, timestamp: null });
    expect(strip(again)).toEqual(strip(result));
  });
});
