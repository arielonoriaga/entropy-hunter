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

  test("finds dedicated and generic-fallback languages", () => {
    expect(result.files_by_language.rust).toBe(9);
    expect(result.files_by_language.typescript).toBe(11);
    expect(result.files_by_language.python).toBe(2); // generic fallback
    expect(result.files_analyzed).toBe(22);
  });

  test("guard signal: sibling ifs sharing a guard are detected and scored", () => {
    const ts = result.files.find((f) => f.path === "typescript/guards/checkout.ts")!;
    expect(ts.guard_clumps).toBe(1);
    expect(ts.max_guard_group).toBe(2);
    expect(ts.guard_prefix).toBe("isLoggedIn()");
    expect(ts.guard_score).toBe(50); // 2 ifs at default cap 4
    const rust = result.files.find((f) => f.path === "rust/guards/src/lib.rs")!;
    expect(rust.max_guard_group).toBe(3);
    expect(rust.guard_score).toBe(75);
    const clean = result.files.find((f) => f.path === "typescript/simple/util.ts")!;
    expect(clean.guard_score).toBe(0);
  });

  test("magic signal: literal-dense files score, named-constant files don't", () => {
    const magic = result.files.find((f) => f.path === "typescript/magic/pricing.ts")!;
    expect(magic.magic_numbers).toBe(6);
    expect(magic.magic_strings).toBe(2);
    expect(magic.magic_score).toBe(100); // 8 literals / 14 LOC — way past 5-per-100 cap
    const clean = result.files.find((f) => f.path === "typescript/simple/util.ts")!;
    expect(clean.magic_score).toBe(0);
  });

  test("generic analyzer: python complexity and imports resolve", () => {
    const worker = result.files.find((f) => f.path === "python/worker.py")!;
    expect(worker.language).toBe("python");
    // process: for + if + and + elif = 5
    expect(worker.complexity_max).toBe(5);
    expect(worker.dependencies).toEqual(["python/helpers.py"]);
    const helpers = result.files.find((f) => f.path === "python/helpers.py")!;
    expect(helpers.fan_in).toBe(1);
    expect(helpers.complexity_max).toBe(2); // clamp: 1 + if (comment stripped)
  });

  test("dead code: unimported non-entrypoint files are orphans", () => {
    const orphan = result.files.find((f) => f.path === "typescript/simple/util.ts")!;
    expect(orphan.is_orphan).toBe(true);
    expect(orphan.deadcode_score).toBe(100);
    const imported = result.files.find((f) => f.path === "typescript/coupled/shared.ts")!;
    expect(imported.is_orphan).toBe(false);
    const entry = result.files.find((f) => f.path === "rust/simple/src/lib.rs")!;
    expect(entry.is_entrypoint).toBe(true);
    expect(entry.deadcode_score).toBe(0);
  });

  test("architecture: domain importing infrastructure is a violation, reverse is not", () => {
    const bad = result.files.find((f) => f.path === "typescript/layered/domain/service.ts")!;
    expect(bad.arch_violations).toBe(1);
    expect(bad.architecture_score).toBeGreaterThan(0);
    const ok = result.files.find((f) => f.path === "typescript/layered/infrastructure/repo.ts")!;
    expect(ok.arch_violations).toBe(0);
    expect(result.architecture_violations).toEqual([
      {
        from: "typescript/layered/domain/service.ts",
        to: "typescript/layered/infrastructure/repo.ts",
        from_layer: "domain",
        to_layer: "infrastructure",
      },
    ]);
  });

  test("reach: transitive dependents counted through the graph", () => {
    const model = result.files.find((f) => f.path === "typescript/layered/domain/model.ts")!;
    expect(model.transitive_dependents).toBe(2); // repo.ts directly, service.ts through it
    expect(model.fan_in).toBe(1);
    expect(model.reach_score).toBeGreaterThan(0);
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
    const keys = [
      "complexity", "coupling", "churn", "duplication", "state",
      "clumping", "deadcode", "architecture", "reach", "magic", "guard",
    ] as const;
    const wsum = keys.reduce((s, k) => s + (w as any)[`${k}_weight`], 0);
    const expected =
      keys.reduce((s, k) => s + (summary as any)[k] * (w as any)[`${k}_weight`], 0) / wsum;
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

  test("JSON schema shape (version 7)", () => {
    expect(result.version).toBe(7);
    expect(result.repository).toHaveProperty("name");
    expect(result.repository).toHaveProperty("commit");
    expect(Array.isArray(result.architecture_violations)).toBe(true);
    for (const k of [
      "entropy", "complexity", "coupling", "churn", "duplication",
      "state", "clumping", "deadcode", "architecture", "reach", "magic", "guard",
    ]) {
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
      "commits", "weighted_commits", "lines_added", "lines_deleted", "lines_changed",
      "duplicated_lines", "duplicated_blocks", "duplication_percentage",
      "complexity_score", "coupling_score", "churn_score",
      "duplication_score", "state_score", "clumping_score", "deadcode_score",
      "architecture_score", "reach_score", "hotspot_score",
      "entropy_contribution", "type_count", "optional_fields", "boolean_fields",
      "max_state_fields", "data_clumps", "max_clump_fields",
      "transitive_dependents", "arch_violations",
      "magic_numbers", "magic_strings", "magic_score",
      "guard_clumps", "max_guard_group", "guard_score",
    ]) {
      expect(typeof (f as any)[k]).toBe("number");
    }
    expect(["accelerating", "stable", "cooling"]).toContain(f.churn_trend);
    expect(typeof f.why).toBe("string");
    expect(Array.isArray(result.files_skipped)).toBe(true);
  });

  test("deterministic: analyzing twice yields identical metrics", () => {
    const again = analyzeRepo(FIXTURES, DEFAULT_CONFIG, DEFAULT_CONFIG.analysis.since, null, null);
    const strip = (r: typeof result) => ({ ...r, timestamp: null });
    expect(strip(again)).toEqual(strip(result));
  });

  test("deterministic across a custom (non-default) weight config", () => {
    const custom = structuredClone(DEFAULT_CONFIG);
    custom.entropy.complexity_weight = 0.5;
    custom.entropy.coupling_weight = 0.1;
    custom.scoring.state_fields_cap = 3;
    const a = analyzeRepo(FIXTURES, custom, custom.analysis.since, null, null);
    const b = analyzeRepo(FIXTURES, custom, custom.analysis.since, null, null);
    const strip = (r: typeof a) => ({ ...r, timestamp: null });
    expect(strip(a)).toEqual(strip(b));
    // and the custom weights actually took effect vs the default run
    expect(a.summary.entropy).not.toBe(result.summary.entropy);
  });

  test("hotspot why-strings name a real signal, or say so when none dominates", () => {
    for (const h of result.hotspots) {
      expect(h.why.length).toBeGreaterThan(0);
      if (h.hotspot_score > 0) {
        expect(h.why).toMatch(/^driven by (complexity|coupling|churn) \(/);
      }
    }
  });
});
