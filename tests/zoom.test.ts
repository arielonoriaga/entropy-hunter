import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { analyzeRepo } from "../src/analyze";
import { DEFAULT_CONFIG, type AnalysisResult, type FileMetrics } from "../src/types";
import { moduleRollups, zoom } from "../src/zoom";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const real = analyzeRepo(FIXTURES, DEFAULT_CONFIG, DEFAULT_CONFIG.analysis.since, null, null);

// A synthetic analysis: only the fields zoom reads matter.
function file(path: string, overrides: Partial<FileMetrics> = {}): FileMetrics {
  const blank = Object.fromEntries(Object.keys(real.files[0]).map((k) => [k, 0]));
  return {
    ...(blank as unknown as FileMetrics),
    path, loc: 100, entropy_score: 10, dependencies: [], dependents: [], duplicate_partners: [],
    ...overrides,
  };
}
const analysis = (files: FileMetrics[]): AnalysisResult => ({ ...real, files });

describe("module rollups", () => {
  test("every directory with enough files is rolled up; the root is left out", () => {
    const modules = moduleRollups(real);
    expect(modules.map((m) => m.path)).toContain("typescript/coupled");
    expect(modules.map((m) => m.path)).not.toContain("");
    expect(modules.every((m) => m.files >= 2)).toBe(true);
  });

  test("shares are the directory's part of the repository's entropy mass", () => {
    const modules = moduleRollups(
      analysis([
        file("a/x.ts", { entropy_score: 30 }), file("a/y.ts", { entropy_score: 30 }),
        file("b/x.ts", { entropy_score: 10 }), file("b/y.ts", { entropy_score: 10 }),
      ]),
    );
    expect(modules.map((m) => [m.path, m.entropy, m.share])).toEqual([["a", 30, 75], ["b", 10, 25]]);
  });

  test("cohesion counts edges that stay inside against those that cross", () => {
    const [a] = moduleRollups(
      analysis([
        file("a/x.ts", { dependencies: ["a/y.ts", "b/z.ts"] }),
        file("a/y.ts", { dependents: ["a/x.ts", "b/z.ts"] }),
        file("b/z.ts"), file("b/w.ts"),
      ]),
    ).filter((m) => m.path === "a");
    expect(a).toMatchObject({ imports_out: 1, imported_by: 1, cohesion: 0.33 });
  });
});

describe("zoom ladder", () => {
  test("climbs file → each directory → repository", () => {
    const ladder = zoom(real, "typescript/coupled/payments.ts")!;
    expect(ladder.levels.map((l) => [l.level, l.path])).toEqual([
      ["file", "typescript/coupled/payments.ts"],
      ["module", "typescript/coupled"],
      ["module", "typescript"],
      ["repository", "."],
    ]);
  });

  test("a directory target starts at that directory; unknown targets are null", () => {
    expect(zoom(real, "typescript/coupled/")!.levels[0]).toMatchObject({ level: "module", path: "typescript/coupled" });
    expect(zoom(real, "no/such/path")).toBeNull();
  });

  test("an outlier among calm siblings is a local problem — fix the file", () => {
    const ladder = zoom(
      analysis([
        file("m/bad.ts", { entropy_score: 60 }),
        file("m/a.ts"), file("m/b.ts"), file("m/c.ts"), file("m/d.ts"),
      ]),
      "m/bad.ts",
    )!;
    expect(ladder.levels[0].lens.map((l) => l.kind)).toEqual(["local"]);
    expect(ladder.fix_at).toBe("m/bad.ts");
  });

  test("the same hot signal across a module is a pattern — fix it at the module", () => {
    const hot = { entropy_score: 40, magic_score: 80 };
    const ladder = zoom(
      analysis([
        file("m/a.ts", hot), file("m/b.ts", hot), file("m/c.ts", hot), file("m/d.ts", hot),
        file("other/x.ts"), file("other/y.ts"), file("other/z.ts"),
      ]),
      "m/a.ts",
    )!;
    expect(ladder.levels[0].lens).toEqual([]); // not an outlier: its siblings look the same
    expect(ladder.levels[1].lens.map((l) => l.kind)).toContain("pattern");
    // The repository does not inherit it: outside `m`, nothing is hot.
    expect(ladder.levels[2].lens.map((l) => l.kind)).not.toContain("pattern");
    expect(ladder.fix_at).toBe("m");
  });

  test("a module whose dependencies mostly cross its boundary has a boundary problem", () => {
    const outside = ["x/1.ts", "x/2.ts", "x/3.ts", "x/4.ts", "x/5.ts"];
    const ladder = zoom(
      analysis([
        file("m/a.ts", { dependencies: outside }), file("m/b.ts"),
        ...outside.map((p) => file(p, { dependents: ["m/a.ts"] })),
      ]),
      "m",
    )!;
    expect(ladder.levels[0].lens.map((l) => l.kind)).toContain("boundary");
  });

  test("clones shared with code outside the module need a home above it", () => {
    const ladder = zoom(
      analysis([
        file("m/a.ts", { duplicate_partners: ["other/x.ts"] }),
        file("m/b.ts", { duplicate_partners: ["other/x.ts"] }),
        file("other/x.ts"), file("other/y.ts"),
      ]),
      "m",
    )!;
    expect(ladder.levels[0].lens.map((l) => l.kind)).toContain("shared-home");
  });

  test("nothing wrong anywhere: every level is healthy and there is no fix target", () => {
    const ladder = zoom(analysis([file("m/a.ts"), file("m/b.ts"), file("m/c.ts")]), "m/a.ts")!;
    expect(ladder.levels.flatMap((l) => l.lens.map((x) => x.kind))).toEqual(["healthy", "healthy", "healthy"]);
    expect(ladder.fix_at).toBeNull();
  });
});
