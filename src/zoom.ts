// `entropy zoom`: the same measurements, one level up.
//
// A hotspot list answers "which file is worst". It cannot tell whether that
// file is the problem or only where a larger problem surfaces. Zoom rolls
// file metrics up the directory tree and, at each level, applies a small
// fixed rule table (the "lens") that says where the cause lives — so a fix
// is aimed at the highest level that actually owns it. Like `entropy
// health`, the lens is deterministic thresholds over computed facts.
import { SIGNALS, type AnalysisResult, type FileMetrics, type Signal } from "./types";

export interface SignalScore {
  signal: Signal;
  score: number;
}

export interface ModuleRollup {
  path: string; // directory, "" = repository root
  files: number;
  loc: number;
  entropy: number; // LOC-weighted mean of the files' entropy_score
  share: number; // % of the whole repository's entropy mass (loc × entropy) inside this directory
  dominant: SignalScore[]; // highest LOC-weighted signal means, worst first (max 3)
  // Of all dependency edges touching this directory, the fraction that stay
  // inside it. null when it has no edges at all.
  cohesion: number | null;
  imports_out: number; // edges from inside to outside
  imported_by: number; // edges from outside to inside
  worst: { path: string; entropy_score: number }[]; // max 3
}

export type LensKind = "local" | "pattern" | "boundary" | "concentrated" | "shared-home" | "healthy";

export interface Lens {
  kind: LensKind;
  message: string;
}

export interface ZoomLevel {
  level: "file" | "module" | "repository";
  path: string;
  entropy: number;
  dominant: SignalScore[];
  lens: Lens[];
}

export interface ZoomResult {
  target: string;
  levels: ZoomLevel[]; // innermost first
  // The outermost level whose lens found a cause — where a fix should aim.
  fix_at: string | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const ATTENTION = 30; // same band boundaries as `entropy health`
const CRITICAL = 70;
const MAX_DOMINANT = 3;
const MAX_WORST = 3;
// Lens thresholds.
const OUTLIER_MARGIN = 10; // file entropy this far above its module's mean = a local problem
const MIN_PATTERN_FILES = 3; // fewer files than this cannot show a pattern
const PATTERN_SHARE = 0.5; // fraction of a module's files sharing one hot signal
const LOW_COHESION = 0.3;
const MIN_BOUNDARY_EDGES = 5;
const CONCENTRATION = 0.5; // one file holding this fraction of a module's entropy mass
const MIN_OUTSIDE_PARTNERS = 2; // files cloning code from outside the module

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const isInside = (path: string, dir: string) => dir === "" || path.startsWith(dir + "/");
const label = (dir: string) => dir || ".";

// Every directory from `dir` up to the root (""), innermost first.
function ancestors(dir: string): string[] {
  const chain = [dir];
  while (chain[chain.length - 1] !== "") chain.push(dirOf(chain[chain.length - 1]));
  return chain;
}

function dominantSignals(files: FileMetrics[], loc: number): SignalScore[] {
  return SIGNALS.map((signal) => ({
    signal,
    score: round1(files.reduce((sum, f) => sum + f[`${signal}_score`] * f.loc, 0) / (loc || 1)),
  }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.signal.localeCompare(b.signal))
    .slice(0, MAX_DOMINANT);
}

function rollup(dir: string, files: FileMetrics[], repoMass: number): ModuleRollup {
  const loc = files.reduce((sum, f) => sum + f.loc, 0);
  const mass = files.reduce((sum, f) => sum + f.entropy_score * f.loc, 0);
  let internal = 0;
  let imports_out = 0;
  let imported_by = 0;
  for (const f of files) {
    for (const dep of f.dependencies) isInside(dep, dir) ? internal++ : imports_out++;
    for (const dependent of f.dependents) if (!isInside(dependent, dir)) imported_by++;
  }
  const edges = internal + imports_out + imported_by;
  return {
    path: dir,
    files: files.length,
    loc,
    entropy: round1(mass / (loc || 1)),
    share: round1((mass / (repoMass || 1)) * 100),
    dominant: dominantSignals(files, loc),
    cohesion: edges ? Math.round((internal / edges) * 100) / 100 : null,
    imports_out,
    imported_by,
    worst: [...files]
      .sort((a, b) => b.entropy_score - a.entropy_score || a.path.localeCompare(b.path))
      .slice(0, MAX_WORST)
      .map((f) => ({ path: f.path, entropy_score: f.entropy_score })),
  };
}

// Files grouped under every directory that contains them (directly or nested).
function filesByDirectory(files: FileMetrics[]): Map<string, FileMetrics[]> {
  const groups = new Map<string, FileMetrics[]>();
  for (const f of files) {
    for (const dir of ancestors(dirOf(f.path))) {
      const group = groups.get(dir);
      if (group) group.push(f);
      else groups.set(dir, [f]);
    }
  }
  return groups;
}

const repoMassOf = (files: FileMetrics[]) => files.reduce((sum, f) => sum + f.entropy_score * f.loc, 0);

// Every directory holding at least `minFiles` analyzed files, the ones
// carrying the most entropy first.
// The repository root is left out — it is always 100% and says nothing.
export function moduleRollups(result: AnalysisResult, minFiles = 2): ModuleRollup[] {
  const repoMass = repoMassOf(result.files);
  return [...filesByDirectory(result.files)]
    .filter(([dir, files]) => dir !== "" && files.length >= minFiles)
    .map(([dir, files]) => rollup(dir, files, repoMass))
    .sort((a, b) => b.share - a.share || b.entropy - a.entropy || a.path.localeCompare(b.path));
}

// --- the lens: where does the cause live? -----------------------------------

// The signal most files of a module are hot on, if at least PATTERN_SHARE of
// them are.
function sharedHotSignal(files: FileMetrics[]): { signal: Signal; count: number } | null {
  if (files.length < MIN_PATTERN_FILES) return null;
  const best = SIGNALS.map((signal) => ({
    signal,
    count: files.filter((f) => f[`${signal}_score`] >= ATTENTION).length,
  })).reduce((a, b) => (b.count > a.count ? b : a));
  return best.count / files.length >= PATTERN_SHARE ? best : null;
}

function fileLens(file: FileMetrics, siblings: FileMetrics[], module: ModuleRollup): Lens[] {
  const lens: Lens[] = [];
  if (siblings.length >= MIN_PATTERN_FILES && file.entropy_score >= module.entropy + OUTLIER_MARGIN) {
    lens.push({
      kind: "local",
      message: `outlier in ${label(module.path)}: entropy ${file.entropy_score} vs the module's ${module.entropy} — the cause is in this file`,
    });
  }
  // A signal that is critical here but not hot across the module is this
  // file's own doing, whatever its blended entropy says.
  for (const signal of SIGNALS) {
    const own = file[`${signal}_score`];
    const shared = siblings.reduce((sum, f) => sum + f[`${signal}_score`] * f.loc, 0) / (module.loc || 1);
    if (own >= CRITICAL && shared < ATTENTION) {
      lens.push({
        kind: "local",
        message: `${signal} ${Math.round(own)} is this file's own — the module averages ${Math.round(shared)}`,
      });
    }
  }
  if (!lens.length && file.entropy_score < ATTENTION && !SIGNALS.some((s) => file[`${s}_score`] >= CRITICAL)) {
    lens.push({ kind: "healthy", message: "below the attention band, with no critical signal" });
  }
  return lens;
}

// below: the files of the level this climb came from (null at the start).
// A level owns a pattern only if it continues OUTSIDE of them — otherwise a
// parent would "inherit" the pattern of the one child that carries it.
function moduleLens(module: ModuleRollup, files: FileMetrics[], below: Set<string> | null): Lens[] {
  const lens: Lens[] = [];
  const elsewhere = below ? files.filter((f) => !below.has(f.path)) : files;
  const pattern = sharedHotSignal(elsewhere);
  if (pattern) {
    lens.push({
      kind: "pattern",
      message: `${pattern.count} of ${elsewhere.length} ${below ? "other " : ""}files are hot on ${pattern.signal} — one shared cause (a missing abstraction or convention); fix it once here, not file by file`,
    });
  }
  const crossing = module.imports_out + module.imported_by;
  if (module.cohesion !== null && module.cohesion < LOW_COHESION && crossing >= MIN_BOUNDARY_EDGES) {
    lens.push({
      kind: "boundary",
      message: `cohesion ${module.cohesion}: ${crossing} dependency edges cross this boundary (${module.imports_out} out, ${module.imported_by} in) — the seam may be in the wrong place`,
    });
  }
  const mass = files.reduce((sum, f) => sum + f.entropy_score * f.loc, 0);
  const heaviest = files.reduce((a, b) => (b.entropy_score * b.loc > a.entropy_score * a.loc ? b : a));
  if (
    files.length >= MIN_PATTERN_FILES && mass > 0 && module.entropy >= ATTENTION &&
    (heaviest.entropy_score * heaviest.loc) / mass >= CONCENTRATION
  ) {
    lens.push({
      kind: "concentrated",
      message: `${heaviest.path} carries most of this module's entropy — the module is fine, that file is not`,
    });
  }
  const cloningOutside = files.filter((f) => f.duplicate_partners.some((p) => !isInside(p, module.path)));
  if (cloningOutside.length >= MIN_OUTSIDE_PARTNERS) {
    lens.push({
      kind: "shared-home",
      message: `${cloningOutside.length} files duplicate code that lives outside this module — the shared code needs a home above it`,
    });
  }
  if (!lens.length && module.entropy < ATTENTION) {
    lens.push({ kind: "healthy", message: "nothing systemic at this level — no reason to climb further" });
  }
  return lens;
}

// "concentrated" points back down at a file, so it is not a cause at its own level.
const CAUSES = new Set<LensKind>(["local", "pattern", "boundary", "shared-home"]);

// The ladder for one file or directory: itself, then each enclosing
// directory up to the repository, each with its lens.
export function zoom(result: AnalysisResult, target: string): ZoomResult | null {
  const path = target.replace(/^\.\//, "").replace(/\/+$/, "");
  const groups = filesByDirectory(result.files);
  const repoMass = repoMassOf(result.files);
  const file = result.files.find((f) => f.path === path);
  if (!file && !groups.has(path === "." ? "" : path)) return null;

  const levels: ZoomLevel[] = [];
  const startDir = file ? dirOf(file.path) : path === "." ? "" : path;
  if (file) {
    const siblings = groups.get(startDir)!;
    levels.push({
      level: "file",
      path: file.path,
      entropy: file.entropy_score,
      dominant: dominantSignals([file], file.loc),
      lens: fileLens(file, siblings, rollup(startDir, siblings, repoMass)),
    });
  }
  let below = file ? new Set([file.path]) : null;
  for (const dir of ancestors(startDir)) {
    const files = groups.get(dir)!;
    const module = rollup(dir, files, repoMass);
    levels.push({
      level: dir === "" ? "repository" : "module",
      path: label(dir),
      entropy: module.entropy,
      dominant: module.dominant,
      lens: moduleLens(module, files, below),
    });
    below = new Set(files.map((f) => f.path));
  }

  const cause = [...levels].reverse().find((level) => level.lens.some((l) => CAUSES.has(l.kind)));
  return { target: path, levels, fix_at: cause?.path ?? null };
}
