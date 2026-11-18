import { describe, expect, test } from "bun:test";
import { afterAll, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, ConfigError } from "../src/validate";
import { loadConfig } from "../src/config";
import { DEFAULT_CONFIG } from "../src/types";

describe("validateConfig", () => {
  test("default config passes", () => {
    expect(() => validateConfig(DEFAULT_CONFIG)).not.toThrow();
  });

  test("a zero/negative scoring cap is rejected (would silently zero that signal)", () => {
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.scoring.complexity_avg_cap = 0;
    expect(() => validateConfig(bad)).toThrow(ConfigError);
    bad.scoring.complexity_avg_cap = -5;
    expect(() => validateConfig(bad)).toThrow(/complexity_avg_cap/);
  });

  test("a negative entropy weight is rejected", () => {
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.entropy.churn_weight = -0.1;
    expect(() => validateConfig(bad)).toThrow(/churn_weight/);
  });

  test("all-zero weights (sum <= 0) is rejected", () => {
    const bad = structuredClone(DEFAULT_CONFIG);
    for (const k of Object.keys(bad.entropy)) (bad.entropy as any)[k] = 0;
    expect(() => validateConfig(bad)).toThrow(/sum to > 0/);
  });

  test("duplicate layer names are rejected", () => {
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.architecture.layers = "domain, domain, api";
    expect(() => validateConfig(bad)).toThrow(/duplicate/);
  });

  test("malformed --since-style analysis.since is rejected", () => {
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.analysis.since = "thirty days";
    expect(() => validateConfig(bad)).toThrow(/since/);
  });

  test("a zero/negative priority.critical_threshold is rejected", () => {
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.priority.critical_threshold = 0;
    expect(() => validateConfig(bad)).toThrow(/critical_threshold/);
  });
});

describe("loadConfig rejects malformed config.toml", () => {
  let dir: string;
  beforeAll(() => (dir = mkdtempSync(join(tmpdir(), "entropy-cfg-"))));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function repoWithConfig(name: string, toml: string): string {
    const repo = mkdtempSync(join(dir, name));
    mkdirSync(join(repo, ".entropy"), { recursive: true });
    writeFileSync(join(repo, ".entropy", "config.toml"), toml);
    return repo;
  }

  test("unknown section is rejected, not silently ignored", () => {
    const repo = repoWithConfig("r1-", "[scorring]\ncomplexity_avg_cap = 5\n");
    expect(() => loadConfig(repo)).toThrow(/unknown section \[scorring\]/);
  });

  test("unknown key in a known section is rejected, not silently dropped", () => {
    const repo = repoWithConfig("r2-", "[entropy]\ncomplexty_weight = 0.5\n");
    expect(() => loadConfig(repo)).toThrow(/unknown key "complexty_weight"/);
  });

  test("type-mismatched value is rejected", () => {
    const repo = repoWithConfig("r3-", '[entropy]\ncomplexity_weight = "high"\n');
    expect(() => loadConfig(repo)).toThrow(/must be a number/);
  });

  test("out-of-range value from a well-formed file is rejected", () => {
    const repo = repoWithConfig("r4-", "[scoring]\nstate_fields_cap = -1\n");
    expect(() => loadConfig(repo)).toThrow(ConfigError);
  });

  test("a valid override is applied", () => {
    const repo = repoWithConfig("r5-", "[hotspots]\nlimit = 5\n");
    expect(loadConfig(repo).hotspots.limit).toBe(5);
  });

  test("[priority] critical_threshold override is applied", () => {
    const repo = repoWithConfig("r6-", "[priority]\ncritical_threshold = 40\n");
    expect(loadConfig(repo).priority.critical_threshold).toBe(40);
  });

  test("[gate] comments is a boolean switch", () => {
    expect(loadConfig(repoWithConfig("r7-", "[gate]\ncomments = false\n")).gate.comments).toBe(false);
    expect(() => loadConfig(repoWithConfig("r8-", "[gate]\ncomments = 3\n"))).toThrow(/comments must be a boolean/);
  });
});
