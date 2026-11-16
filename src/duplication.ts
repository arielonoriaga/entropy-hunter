// MVP clone detector: sliding window of WINDOW normalized lines, hashed
// across the whole repo. A window seen more than once marks its lines as
// duplicated. Files contribute compact fingerprints (window hashes + line
// count), which makes per-file results cacheable. Isolated behind this
// module so a better algorithm can replace it without touching the engine.

export const WINDOW = 6;
// Clone partners reported per file — enough to point at where the shared
// code should live without turning the report into a cross-product.
const MAX_PARTNERS = 5;
// A window owned by more files than this is repo-wide boilerplate: it still
// counts as duplication, but naming "partners" for it is noise (and tallying
// them is quadratic in the owner count).
const MAX_PARTNER_OWNERS = 50;

export interface FileFingerprint {
  // One hash per window start; length = max(0, lineCount - WINDOW + 1).
  // Float64Array of 53-bit integers: numeric keys keep the repo-wide window
  // map fast, and the raw buffer is cached as a BLOB with no JSON round-trip.
  hashes: Float64Array;
  lineCount: number;
}

export interface DuplicationResult {
  duplicated_lines: number;
  duplicated_blocks: number;
  duplication_percentage: number;
  // Other files sharing the most windows with this one, most-shared first.
  partners: string[];
}

const FNV_PRIME_A = 0x01000193;
const FNV_PRIME_B = 0x01000197;
const FNV_OFFSET_A = 0x811c9dc5;
const FNV_OFFSET_B = 0xcbf29ce4;
const LOW_BITS = 21; // 32 high-lane bits + 21 low-lane bits = 53 (safe integer)
const LOW_SHIFT = 32 - LOW_BITS;
const HIGH_SCALE = 2 ** LOW_BITS;

// FNV-1a in two 32-bit lanes (different offset bases/primes), independent of
// the runtime so cached fingerprints stay valid across Bun versions. Each
// line is hashed once; a window's hash folds its WINDOW line hashes, so the
// per-window cost is constant instead of re-hashing ~WINDOW lines of text.
export function fingerprint(lines: string[]): FileFingerprint {
  const lineA = new Uint32Array(lines.length);
  const lineB = new Uint32Array(lines.length);
  for (let l = 0; l < lines.length; l++) {
    const text = lines[l];
    let a = FNV_OFFSET_A;
    let b = FNV_OFFSET_B;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, FNV_PRIME_A);
      b = Math.imul(b ^ c, FNV_PRIME_B);
    }
    lineA[l] = a;
    lineB[l] = b;
  }
  const count = Math.max(0, lines.length - WINDOW + 1);
  const hashes = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    let a = FNV_OFFSET_A;
    let b = FNV_OFFSET_B;
    for (let j = i; j < i + WINDOW; j++) {
      a = Math.imul(a ^ lineA[j], FNV_PRIME_A);
      b = Math.imul(b ^ lineB[j], FNV_PRIME_B);
    }
    hashes[i] = (a >>> 0) * HIGH_SCALE + (b >>> LOW_SHIFT);
  }
  return { hashes, lineCount: lines.length };
}

// Files that share a window, for every window seen in 2+ places.
function ownersOfSharedWindows(
  prints: FileFingerprint[],
  windowCount: Map<number, number>,
): Map<number, number[]> {
  const owners = new Map<number, number[]>();
  for (let file = 0; file < prints.length; file++) {
    for (const h of prints[file].hashes) {
      if ((windowCount.get(h) ?? 0) < 2) continue;
      const list = owners.get(h);
      if (!list) owners.set(h, [file]);
      else if (list[list.length - 1] !== file && list.length <= MAX_PARTNER_OWNERS) list.push(file);
    }
  }
  return owners;
}

function topPartners(
  file: number,
  fp: FileFingerprint,
  owners: Map<number, number[]>,
  paths: string[],
): string[] {
  const shared = new Map<number, number>();
  for (const h of fp.hashes) {
    const list = owners.get(h);
    if (!list || list.length > MAX_PARTNER_OWNERS) continue;
    for (const other of list) {
      if (other !== file) shared.set(other, (shared.get(other) ?? 0) + 1);
    }
  }
  return [...shared]
    .sort((a, b) => b[1] - a[1] || paths[a[0]].localeCompare(paths[b[0]]))
    .slice(0, MAX_PARTNERS)
    .map(([other]) => paths[other]);
}

export function detectDuplication(
  files: Map<string, FileFingerprint>,
): Map<string, DuplicationResult> {
  const paths = [...files.keys()];
  const prints = [...files.values()];
  const windowCount = new Map<number, number>();
  for (const fp of prints) {
    for (const h of fp.hashes) windowCount.set(h, (windowCount.get(h) ?? 0) + 1);
  }
  const owners = ownersOfSharedWindows(prints, windowCount);

  const result = new Map<string, DuplicationResult>();
  for (let file = 0; file < prints.length; file++) {
    const fp = prints[file];
    const dup = new Uint8Array(fp.lineCount);
    for (let i = 0; i < fp.hashes.length; i++) {
      if ((windowCount.get(fp.hashes[i]) ?? 0) > 1) dup.fill(1, i, i + WINDOW);
    }
    let duplicated_lines = 0;
    let duplicated_blocks = 0;
    for (let i = 0; i < dup.length; i++) {
      if (dup[i]) {
        duplicated_lines++;
        if (i === 0 || !dup[i - 1]) duplicated_blocks++; // maximal run start
      }
    }
    result.set(paths[file], {
      duplicated_lines,
      duplicated_blocks,
      duplication_percentage: fp.lineCount ? (duplicated_lines / fp.lineCount) * 100 : 0,
      partners: duplicated_lines ? topPartners(file, fp, owners, paths) : [],
    });
  }
  return result;
}
