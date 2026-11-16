import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRepo, recordWaiver, type CheckResult } from "../src/check";
import { GitError } from "../src/git";
import { Storage } from "../src/storage";
import { DEFAULT_CONFIG } from "../src/types";
import { branchy, tempRepo, type TempRepo } from "./support";

const cleanup: string[] = [];
afterAll(() => cleanup.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

let repo: TempRepo;
beforeEach(() => {
  repo = tempRepo("entropy-check-");
  cleanup.push(repo.path);
  repo.write("src/pricing.ts", branchy("price", 3));
  repo.write("src/util.ts", "export const double = (n: number) => n * 2;\n");
  repo.commit("base");
});

const check = (storage: Storage | null = null, only: string[] | null = null, base = "HEAD"): CheckResult =>
  checkRepo(repo.path, DEFAULT_CONFIG, { base, since: "30d", only, touchedSince: null }, storage, null);
const fileOf = (result: CheckResult, path: string) => result.files.find((f) => f.path === path)!;
const rulesOf = (result: CheckResult, path: string) => fileOf(result, path).findings.map((f) => f.rule);

describe("entropy check", () => {
  test("no changes: passes without analyzing anything", () => {
    expect(check()).toMatchObject({ verdict: "pass", files: [], summary: { files_changed: 0 } });
  });

  test("a harmless edit passes", () => {
    repo.write("src/util.ts", "export const double = (n: number) => n * 2;\nexport const triple = (n: number) => n * 3;\n");
    const result = check();
    expect(result.verdict).toBe("pass");
    expect(fileOf(result, "src/util.ts")).toMatchObject({ status: "modified", verdict: "pass", findings: [] });
  });

  test("a function growing past the complexity limit fails, naming the function", () => {
    repo.write("src/pricing.ts", branchy("price", 20));
    const result = check();
    expect(result.verdict).toBe("fail");
    const finding = fileOf(result, "src/pricing.ts").findings.find((f) => f.rule === "complexity")!;
    expect(finding.level).toBe("fail");
    expect(finding.message).toContain("`price`");
    expect(finding.message).toContain("4 → 21");
  });

  test("complexity that was already there is not this change's regression", () => {
    repo.write("src/legacy.ts", branchy("legacy", 25));
    repo.commit("legacy lands");
    repo.write("src/legacy.ts", branchy("legacy", 25) + "export const one = 1;\n");
    expect(rulesOf(check(), "src/legacy.ts")).not.toContain("complexity");
  });

  test("renaming or extracting a complex function is not new complexity", () => {
    repo.write("src/legacy.ts", branchy("legacy", 25));
    repo.commit("legacy lands");
    repo.write("src/legacy.ts", branchy("renamed", 25));
    expect(rulesOf(check(), "src/legacy.ts")).not.toContain("complexity");
  });

  test("a new file is judged against nothing: complex and untested fails and warns", () => {
    repo.write("src/monster.ts", branchy("monster", 40));
    const result = check();
    const file = fileOf(result, "src/monster.ts");
    expect(file).toMatchObject({ status: "added", entropy_before: null, verdict: "fail" });
    expect(rulesOf(result, "src/monster.ts")).toEqual(expect.arrayContaining(["complexity", "untested", "orphan"]));
  });

  test("copy-pasting a block fails on duplication and names the other file", () => {
    const block = Array.from({ length: 12 }, (_, i) => `  total += items[${i}].price * rate${i};`).join("\n");
    repo.write("src/a.ts", `export function a(items: any[], total = 0) {\n${block}\n  return total;\n}\n`);
    repo.commit("a");
    repo.write("src/b.ts", `export function b(items: any[], total = 0) {\n${block}\n  return total;\n}\n`);
    const finding = fileOf(check(), "src/b.ts").findings.find((f) => f.rule === "duplication")!;
    expect(finding.level).toBe("fail");
    expect(finding.message).toContain("src/a.ts");
  });

  test("closing an import loop fails on the file that closed it", () => {
    repo.write("src/a.ts", 'import { b } from "./b";\nexport const a = () => b();\n');
    repo.write("src/b.ts", "export const b = () => 1;\n");
    repo.commit("a → b");
    repo.write("src/b.ts", 'import { a } from "./a";\nexport const b = () => a();\n');
    const result = check();
    expect(rulesOf(result, "src/b.ts")).toContain("cycle");
    expect(result.verdict).toBe("fail");
  });

  test("an inner layer importing an outer one fails on architecture", () => {
    repo.write("src/domain/order.ts", "export const order = 1;\n");
    repo.write("src/infrastructure/db.ts", "export const db = 1;\n");
    repo.commit("layers");
    repo.write("src/domain/order.ts", 'import { db } from "../infrastructure/db";\nexport const order = db;\n');
    expect(rulesOf(check(), "src/domain/order.ts")).toContain("architecture");
  });

  test("a renamed file is compared with its old self, not treated as new", () => {
    repo.write("src/legacy.ts", branchy("legacy", 25));
    repo.commit("legacy lands");
    repo.git("mv", "src/legacy.ts", "src/moved.ts");
    const file = fileOf(check(), "src/moved.ts");
    expect(file).toMatchObject({ status: "renamed", base_path: "src/legacy.ts", verdict: "pass" });
    expect(file.entropy_before).not.toBeNull();
  });

  test("committed work is compared against the given base, not just HEAD", () => {
    const base = repo.git("rev-parse", "HEAD");
    repo.write("src/pricing.ts", branchy("price", 20));
    repo.commit("regression, committed");
    expect(check(null, null, "HEAD").files).toEqual([]);
    expect(check(null, null, base).verdict).toBe("fail");
  });

  test("--files narrows the verdict to the named paths", () => {
    repo.write("src/pricing.ts", branchy("price", 20));
    repo.write("src/util.ts", "export const double = (n: number) => n + n;\n");
    const result = check(null, ["src/util.ts"]);
    expect(result.files.map((f) => f.path)).toEqual(["src/util.ts"]);
    expect(result.verdict).toBe("pass");
  });

  test("--touched-since leaves out files last modified before that instant", () => {
    repo.write("src/pricing.ts", branchy("price", 20));
    repo.write("src/util.ts", "export const double = (n: number) => n + n;\n");
    const longAgo = new Date("2020-01-01T00:00:00Z");
    utimesSync(join(repo.path, "src/pricing.ts"), longAgo, longAgo);
    const options = { base: "HEAD", since: "30d", only: null, touchedSince: Date.now() - 60_000 };
    const result = checkRepo(repo.path, DEFAULT_CONFIG, options, null, null);
    expect(result.files.map((f) => f.path)).toEqual(["src/util.ts"]);
    expect(result.verdict).toBe("pass");
  });

  test("a waiver accepts a failing file as it is, until the file changes again", () => {
    const dir = mkdtempSync(join(tmpdir(), "entropy-waiver-"));
    cleanup.push(dir);
    const storage = new Storage(join(dir, "cache.db"));
    repo.write("src/pricing.ts", branchy("price", 20));
    expect(check(storage).verdict).toBe("fail");

    recordWaiver(storage, repo.path, "src/pricing.ts", "generated lookup table");
    const waived = check(storage);
    expect(waived.verdict).toBe("pass");
    expect(fileOf(waived, "src/pricing.ts")).toMatchObject({ verdict: "waived", waiver: "generated lookup table" });
    expect(waived.summary.waived).toBe(1);

    repo.write("src/pricing.ts", branchy("price", 21));
    expect(check(storage).verdict).toBe("fail");
    storage.close();
  });

  test("an unknown base is an error, not a silent pass", () => {
    expect(() => check(null, null, "no-such-ref")).toThrow(GitError);
  });
});
