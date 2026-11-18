import { stripCommentsAndStrings } from "./languages/strip";
import type { SourceTree } from "./tree";

// TypeScript/JavaScript path aliases (`compilerOptions.paths` / `baseUrl` in
// tsconfig*.json / jsconfig.json). Without them every `~/x` or `@/x` import
// looks like an external package, and the dependency graph of an aliased
// codebase — fan-in, reach, cycles, orphans, architecture — is mostly empty.

interface AliasRule {
  prefix: string; // pattern text before `*` (the whole pattern if there is none)
  suffix: string; // pattern text after `*`
  wildcard: boolean;
  targets: string[]; // repo-relative, `*` still in place
}

interface DirAliases {
  rules: AliasRule[]; // longest prefix first — TypeScript's match order
  baseUrl: string | null; // repo-relative
}

export interface AliasResolver {
  // Repo-relative paths (extension-less) a bare specifier may point at,
  // for an importer at `fromPath`. Empty when no alias applies.
  candidates(spec: string, fromPath: string): string[];
}

export const NO_ALIASES: AliasResolver = { candidates: () => [] };

const CONFIG_FILE = /(^|\/)[tj]sconfig(\.[\w.-]+)?\.json$/;
const MAX_EXTENDS_DEPTH = 5;

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

// Join + normalize repo-relative segments ("a/b", "../c") → "a/c".
export function joinPath(...parts: string[]): string {
  const out: string[] = [];
  for (const seg of parts.join("/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

function parseJsonc(text: string): any {
  const noComments = stripCommentsAndStrings(text, "json", "keep-strings");
  try {
    return JSON.parse(noComments.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}

interface RawOptions {
  baseUrl: string | null; // repo-relative
  paths: { owner: string; map: Record<string, unknown> } | null; // owner = dir of the config defining them
}

// compilerOptions of `configPath` with `extends` applied: the nearest
// definition of each option wins, and each is anchored to the config that
// defined it (that is what its relative paths are relative to).
function readOptions(tree: SourceTree, configPath: string, depth = 0): RawOptions {
  const config = parseJsonc(tree.read(configPath) ?? "");
  if (!config || typeof config !== "object") return { baseUrl: null, paths: null };
  const dir = dirOf(configPath);
  const own = config.compilerOptions ?? {};
  let inherited: RawOptions = { baseUrl: null, paths: null };
  const parents = [config.extends].flat().filter((e): e is string => typeof e === "string");
  if (depth < MAX_EXTENDS_DEPTH) {
    for (const parent of parents) {
      if (!parent.startsWith(".")) continue; // package presets define no project aliases
      const target = joinPath(dir, parent.endsWith(".json") ? parent : `${parent}.json`);
      const options = readOptions(tree, target, depth + 1);
      inherited = {
        baseUrl: options.baseUrl ?? inherited.baseUrl,
        paths: options.paths ?? inherited.paths,
      };
    }
  }
  return {
    baseUrl: typeof own.baseUrl === "string" ? joinPath(dir, own.baseUrl) : inherited.baseUrl,
    paths: own.paths && typeof own.paths === "object" ? { owner: dir, map: own.paths } : inherited.paths,
  };
}

function toRules(options: RawOptions): AliasRule[] {
  if (!options.paths) return [];
  const anchor = options.baseUrl ?? options.paths.owner;
  const rules: AliasRule[] = [];
  for (const [pattern, targets] of Object.entries(options.paths.map)) {
    if (!Array.isArray(targets)) continue;
    const star = pattern.indexOf("*");
    rules.push({
      prefix: star === -1 ? pattern : pattern.slice(0, star),
      suffix: star === -1 ? "" : pattern.slice(star + 1),
      wildcard: star !== -1,
      targets: targets.filter((t): t is string => typeof t === "string").map((t) => joinPath(anchor, t)),
    });
  }
  return rules.sort((a, b) => b.prefix.length - a.prefix.length || a.prefix.localeCompare(b.prefix));
}

export function loadAliases(tree: SourceTree): AliasResolver {
  const configsByDir = new Map<string, string[]>();
  for (const file of tree.files) {
    if (!CONFIG_FILE.test(file)) continue;
    const dir = dirOf(file);
    configsByDir.set(dir, [...(configsByDir.get(dir) ?? []), file]);
  }
  if (!configsByDir.size) return NO_ALIASES;

  // A directory's aliases: every config in it, merged (an app/node/test
  // split across tsconfig.*.json is one project as far as imports go).
  const byDir = new Map<string, DirAliases>();
  for (const [dir, configs] of configsByDir) {
    const options = configs.sort().map((c) => readOptions(tree, c));
    byDir.set(dir, {
      rules: options.flatMap(toRules).sort((a, b) => b.prefix.length - a.prefix.length),
      baseUrl: options.find((o) => o.baseUrl !== null)?.baseUrl ?? null,
    });
  }

  // Nearest enclosing config directory, memoized per importing directory.
  const nearest = new Map<string, DirAliases | null>();
  const aliasesFor = (dir: string): DirAliases | null => {
    const known = nearest.get(dir);
    if (known !== undefined) return known;
    const found = byDir.get(dir) ?? (dir === "" ? null : aliasesFor(dirOf(dir)));
    nearest.set(dir, found);
    return found;
  };

  return {
    candidates(spec, fromPath) {
      const aliases = aliasesFor(dirOf(fromPath));
      if (!aliases) return [];
      const rule = aliases.rules.find((r) =>
        r.wildcard
          ? spec.length >= r.prefix.length + r.suffix.length &&
            spec.startsWith(r.prefix) && spec.endsWith(r.suffix)
          : spec === r.prefix,
      );
      const matched = rule
        ? rule.targets.map((t) =>
            rule.wildcard
              ? t.replace("*", () => spec.slice(rule.prefix.length, spec.length - rule.suffix.length))
              : t,
          )
        : [];
      return aliases.baseUrl === null ? matched : [...matched, joinPath(aliases.baseUrl, spec)];
    },
  };
}
